import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

export class SimpleWebSocketServer extends EventEmitter {
  constructor({ maxPayload = 64 * 1024 } = {}) {
    super();
    this.maxPayload = maxPayload;
    this.clients = new Set();
  }

  handleUpgrade(request, socket, head, callback) {
    const upgrade = String(request.headers.upgrade || "").toLowerCase();
    const connection = String(request.headers.connection || "").toLowerCase();
    const key = String(request.headers["sec-websocket-key"] || "");
    const version = String(request.headers["sec-websocket-version"] || "");

    if (upgrade !== "websocket" || !connection.includes("upgrade") || !key || version !== "13") {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n"
    ].join("\r\n"));

    const websocket = new SimpleWebSocket(socket, { maxPayload: this.maxPayload });
    this.clients.add(websocket);
    websocket.once("close", () => this.clients.delete(websocket));

    if (head?.length) websocket.feed(head);
    callback(websocket);
  }
}

export class SimpleWebSocket extends EventEmitter {
  constructor(socket, { maxPayload }) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.readyState = WS_OPEN;
    this.buffer = Buffer.alloc(0);
    this.closeEmitted = false;

    socket.on("data", (chunk) => this.feed(chunk));
    socket.on("error", (error) => {
      if (this.listenerCount("error") > 0) this.emit("error", error);
      else this.finishClose(1006, "Socket error");
    });
    socket.on("end", () => this.finishClose(1006, "Connection ended"));
    socket.on("close", () => this.finishClose(1006, "Connection closed"));
  }

  feed(chunk) {
    if (this.readyState === WS_CLOSED || !chunk?.length) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let payloadLength = second & 0x7f;
      let offset = 2;

      if (rsv !== 0 || !masked) {
        this.protocolClose(1002, "Invalid frame");
        return;
      }

      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) return;
        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) return;
        const length64 = this.buffer.readBigUInt64BE(offset);
        if (length64 > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.protocolClose(1009, "Payload too large");
          return;
        }
        payloadLength = Number(length64);
        offset += 8;
      }

      if (payloadLength > this.maxPayload) {
        this.protocolClose(1009, "Payload too large");
        return;
      }

      const totalLength = offset + 4 + payloadLength;
      if (this.buffer.length < totalLength) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLength));
      this.buffer = this.buffer.subarray(totalLength);

      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }

      if (!fin && opcode !== 0x0) {
        this.protocolClose(1003, "Fragmented messages are not supported");
        return;
      }

      switch (opcode) {
        case 0x1:
          if (!fin) {
            this.protocolClose(1003, "Fragmented messages are not supported");
            return;
          }
          this.emit("message", payload, false);
          break;
        case 0x2:
          this.emit("message", payload, true);
          break;
        case 0x8:
          this.handleCloseFrame(payload);
          return;
        case 0x9:
          this.writeFrame(0xA, payload);
          break;
        case 0xA:
          this.emit("pong", payload);
          break;
        default:
          this.protocolClose(1002, "Unsupported opcode");
          return;
      }
    }
  }

  send(data) {
    if (this.readyState !== WS_OPEN) return false;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    this.writeFrame(0x1, payload);
    return true;
  }

  ping(data = Buffer.alloc(0)) {
    if (this.readyState !== WS_OPEN) return false;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    if (payload.length > 125) throw new RangeError("Ping payload must be 125 bytes or fewer");
    this.writeFrame(0x9, payload);
    return true;
  }

  close(code = 1000, reason = "") {
    if (this.readyState === WS_CLOSED || this.readyState === WS_CLOSING) return;
    this.readyState = WS_CLOSING;
    const reasonBuffer = Buffer.from(String(reason).slice(0, 123));
    const payload = Buffer.allocUnsafe(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this.writeFrame(0x8, payload, true);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1_000).unref();
  }

  terminate() {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this.socket.destroy();
    this.finishClose(1006, "Terminated");
  }

  handleCloseFrame(payload) {
    let code = 1000;
    let reason = "";
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      reason = payload.subarray(2).toString("utf8");
    }

    if (this.readyState === WS_OPEN) {
      this.readyState = WS_CLOSING;
      this.writeFrame(0x8, payload, true);
    }
    this.socket.end();
    this.finishClose(code, reason);
  }

  protocolClose(code, reason) {
    this.close(code, reason);
  }

  writeFrame(opcode, payload, allowClosing = false) {
    if (!allowClosing && this.readyState !== WS_OPEN) return;
    if (allowClosing && this.readyState === WS_CLOSED) return;

    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = length;
    } else if (length <= 0xffff) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    this.socket.write(Buffer.concat([header, payload]));
  }

  finishClose(code, reason) {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.readyState = WS_CLOSED;
    this.emit("close", code, reason);
  }
}
