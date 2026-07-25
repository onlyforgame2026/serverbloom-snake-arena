import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 31987;

function waitForMessage(socket, predicate, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);

    const handler = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", handler);
    };

    socket.addEventListener("message", handler);
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return;
    } catch {
      // Server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not become healthy");
}

test("two browser clients join the same public arena and start a ranked round", async (t) => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(PORT),
      COUNTDOWN_SECONDS: "3",
      TICK_MS: "180"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  t.after(() => {
    child.kill("SIGTERM");
  });

  await waitForHealth();

  const first = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const second = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  t.after(() => {
    first.close();
    second.close();
  });

  await Promise.all([
    new Promise((resolve, reject) => {
      first.addEventListener("open", resolve, { once: true });
      first.addEventListener("error", reject, { once: true });
    }),
    new Promise((resolve, reject) => {
      second.addEventListener("open", resolve, { once: true });
      second.addEventListener("error", reject, { once: true });
    })
  ]);

  const firstJoined = waitForMessage(first, (message) => message.type === "joined");
  first.send(JSON.stringify({ type: "join", name: "Alyona" }));
  assert.ok((await firstJoined).playerId);

  const secondJoined = waitForMessage(second, (message) => message.type === "joined");
  second.send(JSON.stringify({ type: "join", name: "Bloom" }));
  assert.ok((await secondJoined).playerId);

  const rankedState = await waitForMessage(
    first,
    (message) => message.type === "state" && message.mode === "ranked" && message.players?.length === 2,
    8_000
  );

  assert.equal(rankedState.status, "playing");
  assert.equal(rankedState.players.filter((player) => player.alive).length, 2);
  assert.equal(stderr, "");
});
