"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const canvas = $("#gameCanvas");
const ctx = canvas.getContext("2d");

const state = {
  socket: null,
  reconnectTimer: null,
  pingTimer: null,
  joined: false,
  manualLeave: false,
  desiredName: "",
  playerId: "",
  arena: null,
  game: null,
  result: null,
  latency: null,
  lastPingAt: 0,
  cols: 72,
  rows: 40,
  cssWidth: 0,
  cssHeight: 0,
  pixelRatio: 1,
  cell: 20,
  boardWidth: 0,
  boardHeight: 0,
  offsetX: 0,
  offsetY: 0,
  soundEnabled: true,
  audioContext: null,
  lastFoodKey: ""
};

function websocketUrl() {
  const supplied = new URLSearchParams(location.search).get("server");
  if (supplied) {
    try {
      const parsed = new URL(supplied);
      if (parsed.protocol === "ws:" || parsed.protocol === "wss:") return parsed.toString();
    } catch {
      // Fall through to same-origin WebSocket.
    }
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

function joinArena() {
  const name = sanitizeName($("#nameInput").value);
  if (!name) {
    showToast("請先輸入遊戲名稱");
    $("#nameInput").focus();
    return;
  }

  state.desiredName = name;
  state.manualLeave = false;
  localStorage.setItem("serverbloom_snake_name", name);
  $("#joinButton").disabled = true;
  connect();
}

function connect() {
  clearTimeout(state.reconnectTimer);
  closeSocket(false);
  setConnection("connecting", "連線中…");

  try {
    state.socket = new WebSocket(websocketUrl());
  } catch {
    setConnection("error", "伺服器網址錯誤");
    $("#joinButton").disabled = false;
    return;
  }

  state.socket.addEventListener("open", () => {
    setConnection("online", "已連線");
    $("#joinButton").disabled = false;
    startPingLoop();
    safeSend({ type: "join", name: state.desiredName });
  });

  state.socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMessage(message);
  });

  state.socket.addEventListener("close", (event) => {
    clearInterval(state.pingTimer);
    state.pingTimer = null;
    state.socket = null;
    state.joined = false;
    state.playerId = "";
    setConnection("error", event.code === 1000 ? "已離線" : "連線中斷");

    if (!state.manualLeave && state.desiredName) {
      setStatus("連線中斷，正在重新加入公開戰局…");
      state.reconnectTimer = setTimeout(connect, 2200);
    } else {
      showOverlay("join");
    }
  });

  state.socket.addEventListener("error", () => {
    setConnection("error", "連線失敗");
  });
}

function handleMessage(message) {
  switch (message.type) {
    case "hello":
      state.cols = Number(message.cols) || state.cols;
      state.rows = Number(message.rows) || state.rows;
      resizeCanvas();
      break;

    case "joined":
      state.playerId = String(message.playerId || "");
      state.joined = true;
      $("#leaveButton").hidden = false;
      showToast(String(message.message || "已加入公開戰局"));
      break;

    case "arena":
      state.arena = message;
      renderArena();
      break;

    case "state":
      state.game = message;
      state.cols = Number(message.cols) || state.cols;
      state.rows = Number(message.rows) || state.rows;
      renderGameUi();
      playFoodSoundIfNeeded();
      break;

    case "game_over":
      state.result = message;
      renderResult(message);
      break;

    case "pong":
      state.latency = Math.max(0, Date.now() - Number(message.sentAt || Date.now()));
      $("#latencyText").textContent = `${state.latency} ms`;
      break;

    case "left":
      resetClient();
      break;

    case "error":
      showToast(String(message.message || "伺服器發生錯誤"));
      if (message.code === "ARENA_FULL" || message.code === "BAD_NAME") {
        state.manualLeave = true;
        closeSocket(true);
      }
      break;

    default:
      break;
  }
}

function renderArena() {
  if (!state.arena) return;
  renderPlayerList(state.arena.players || []);

  const me = (state.arena.players || []).find((player) => player.id === state.playerId);
  const connected = Number(state.arena.connected || 0);
  $("#modeLabel").textContent = `唯一公開戰局・${connected}/${state.arena.maxPlayers || 12}`;

  if (state.arena.status === "countdown") {
    const seconds = Number(state.arena.countdown ?? 0);
    $("#countdownValue").textContent = seconds;
    $("#resultCountdown").textContent = seconds;

    if (state.result && state.result.round === state.arena.round) {
      $("#resultOverlay").hidden = false;
      $("#waitingOverlay").hidden = true;
    } else {
      state.result = null;
      $("#waitingEyebrow").textContent = me?.status === "spectating" ? "YOU ARE QUEUED" : "NEXT ROUND";
      $("#waitingTitle").textContent = seconds > 0 ? `${seconds} 秒後開戰` : "準備出生";
      $("#waitingMessage").textContent = connected >= 2
        ? "本局為正式競技，最後存活者獲勝。"
        : "目前只有 1 人，會進入自由練習且不計排名。";
      renderWaitingPlayers(state.arena.players || []);
      showOverlay("waiting");
    }

    setStatus(connected >= 2
      ? `正式戰局即將開始，目前 ${connected} 位玩家。`
      : "目前只有你，下一局為自由練習。第二位玩家加入後，下局才計正式勝負。");
    return;
  }

  if (state.arena.status === "playing") {
    $("#waitingOverlay").hidden = true;
    $("#resultOverlay").hidden = true;
    const isAlive = me?.status === "alive";
    $("#spectatorBanner").hidden = Boolean(isAlive);
    $("#touchControls").hidden = !isAlive;
    setStatus(isAlive
      ? "方向鍵／WASD 控制。撞牆、撞自己或撞其他玩家都會出局。"
      : "你正在觀戰；本局結束後會自動加入下一局。"
    );
    return;
  }

  if (state.arena.status === "waiting") {
    showOverlay("waiting");
    $("#waitingTitle").textContent = "等待玩家";
    $("#waitingMessage").textContent = "有人加入後，伺服器會自動開始倒數。";
  }
}

function renderGameUi() {
  const players = state.game?.players || [];
  const me = players.find((player) => player.id === state.playerId);
  const alive = players.filter((player) => player.alive).length;

  $("#myScore").textContent = Number(me?.score || 0);
  $("#myWins").textContent = Number(me?.wins || 0);
  $("#aliveCount").textContent = `${alive} / ${players.length}`;
  $("#modeLabel").textContent = state.game?.mode === "ranked"
    ? `第 ${state.game.round} 局・正式競技`
    : `第 ${state.game.round} 局・自由練習`;

  renderPlayerList(players);

  if (me && !me.alive && state.game.status === "playing") {
    $("#spectatorBanner").hidden = false;
    $("#touchControls").hidden = true;
  }
}

function renderPlayerList(players) {
  const list = $("#playerList");
  list.hidden = !state.joined || players.length === 0;
  if (list.hidden) return;

  const rows = players
    .slice()
    .sort((a, b) => Number(b.alive) - Number(a.alive) || Number(b.score || 0) - Number(a.score || 0))
    .map((player) => {
      const status = player.status === "alive"
        ? `${Number(player.score || 0)} 分`
        : player.status === "dead"
          ? "出局"
          : player.status === "spectating"
            ? "觀戰"
            : "待命";
      return `
        <div class="player-row ${player.id === state.playerId ? "me" : ""}">
          <span class="player-color" style="--player-color:${escapeAttribute(player.color)}"></span>
          <span class="player-name">${escapeHtml(player.name)}${player.id === state.playerId ? "（你）" : ""}</span>
          <span class="player-meta">${status}・${Number(player.wins || 0)} 勝</span>
        </div>`;
    })
    .join("");

  list.innerHTML = `<div class="player-list-title"><span>在線玩家</span><span>${players.length}</span></div>${rows}`;
}

function renderWaitingPlayers(players) {
  $("#waitingPlayers").innerHTML = players.map((player) => `
    <span class="waiting-player">
      <span class="player-color" style="--player-color:${escapeAttribute(player.color)}"></span>
      ${escapeHtml(player.name)}${player.id === state.playerId ? "（你）" : ""}
    </span>`).join("");
}

function renderResult(result) {
  const won = result.winnerId && result.winnerId === state.playerId;
  $("#resultIcon").textContent = won ? "🏆" : result.winnerId ? "🌙" : "⚔️";
  $("#resultTitle").textContent = String(result.resultText || "戰局結束");
  $("#resultMessage").textContent = result.ranked
    ? won ? "漂亮，你活到最後。下一局所有在線玩家會重新出生。" : "下一局所有在線玩家會重新出生。"
    : "這局是單人練習，因此不計正式勝負。";

  $("#resultTable").innerHTML = (result.players || []).map((player, index) => `
    <div class="result-row">
      <span class="result-rank">#${index + 1}</span>
      <span class="player-color" style="--player-color:${escapeAttribute(player.color)}"></span>
      <span class="result-name">${escapeHtml(player.name)}${player.id === state.playerId ? "（你）" : ""}</span>
      <span class="result-score">${Number(player.score || 0)} 分・${Number(player.wins || 0)} 勝</span>
    </div>`).join("");

  showOverlay("result");
  playEndSound(won);
}

function showOverlay(name) {
  $("#joinOverlay").hidden = name !== "join";
  $("#waitingOverlay").hidden = name !== "waiting";
  $("#resultOverlay").hidden = name !== "result";
}

function queueDirection(direction) {
  const me = state.game?.players?.find((player) => player.id === state.playerId);
  if (!me?.alive) return;
  safeSend({ type: "direction", direction });
}

function leaveArena() {
  state.manualLeave = true;
  safeSend({ type: "leave" });
  setTimeout(() => closeSocket(true), 100);
  resetClient();
}

function resetClient() {
  state.joined = false;
  state.playerId = "";
  state.arena = null;
  state.game = null;
  state.result = null;
  $("#leaveButton").hidden = true;
  $("#playerList").hidden = true;
  $("#spectatorBanner").hidden = true;
  $("#touchControls").hidden = true;
  $("#joinButton").disabled = false;
  setStatus("輸入名稱後加入唯一公開戰局。");
  showOverlay("join");
}

function closeSocket(normal) {
  clearInterval(state.pingTimer);
  state.pingTimer = null;
  if (state.socket) {
    state.socket.onclose = null;
    try { state.socket.close(normal ? 1000 : 1001, normal ? "Client leave" : "Reconnect"); } catch { /* noop */ }
  }
  state.socket = null;
}

function safeSend(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
  state.socket.send(JSON.stringify(payload));
  return true;
}

function startPingLoop() {
  clearInterval(state.pingTimer);
  state.pingTimer = setInterval(() => {
    state.lastPingAt = Date.now();
    safeSend({ type: "ping", sentAt: state.lastPingAt });
  }, 4000);
}

function setConnection(status, text) {
  const pill = $("#connectionPill");
  pill.classList.remove("online", "error");
  if (status === "online") pill.classList.add("online");
  if (status === "error") pill.classList.add("error");
  $("#connectionText").textContent = text;
}

function setStatus(text) {
  $("#statusText").textContent = text;
}

function showToast(text) {
  const toast = $("#toast");
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function resizeCanvas() {
  state.cssWidth = window.innerWidth;
  state.cssHeight = window.innerHeight;
  state.pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(state.cssWidth * state.pixelRatio);
  canvas.height = Math.round(state.cssHeight * state.pixelRatio);
  ctx.setTransform(state.pixelRatio, 0, 0, state.pixelRatio, 0, 0);
  state.cell = Math.min(state.cssWidth / state.cols, state.cssHeight / state.rows);
  state.boardWidth = state.cell * state.cols;
  state.boardHeight = state.cell * state.rows;
  state.offsetX = (state.cssWidth - state.boardWidth) / 2;
  state.offsetY = (state.cssHeight - state.boardHeight) / 2;
}

function renderFrame(time) {
  drawBackground(time);
  if (state.game?.food) drawFood(state.game.food, time);
  for (const player of state.game?.players || []) drawPlayer(player);
  requestAnimationFrame(renderFrame);
}

function drawBackground(time) {
  const gradient = ctx.createRadialGradient(
    state.cssWidth * 0.5,
    state.cssHeight * 0.08,
    20,
    state.cssWidth * 0.5,
    state.cssHeight * 0.5,
    Math.max(state.cssWidth, state.cssHeight) * 0.78
  );
  gradient.addColorStop(0, "#27113c");
  gradient.addColorStop(0.55, "#100719");
  gradient.addColorStop(1, "#07030d");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, state.cssWidth, state.cssHeight);

  ctx.save();
  ctx.translate(state.offsetX, state.offsetY);
  ctx.fillStyle = "rgba(9,4,15,.8)";
  ctx.fillRect(0, 0, state.boardWidth, state.boardHeight);
  ctx.strokeStyle = "rgba(221,186,255,.052)";
  ctx.lineWidth = 1;

  for (let x = 0; x <= state.cols; x += 1) {
    ctx.beginPath();
    ctx.moveTo(x * state.cell + 0.5, 0);
    ctx.lineTo(x * state.cell + 0.5, state.boardHeight);
    ctx.stroke();
  }
  for (let y = 0; y <= state.rows; y += 1) {
    ctx.beginPath();
    ctx.moveTo(0, y * state.cell + 0.5);
    ctx.lineTo(state.boardWidth, y * state.cell + 0.5);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255,255,255,.18)";
  ctx.strokeRect(0.5, 0.5, state.boardWidth - 1, state.boardHeight - 1);
  ctx.restore();

  for (let index = 0; index < 38; index += 1) {
    const x = (index * 173 + 37) % Math.max(1, state.cssWidth);
    const y = (index * 97 + 53) % Math.max(1, state.cssHeight);
    const alpha = 0.06 + Math.sin(time * 0.0014 + index) * 0.025;
    ctx.fillStyle = `rgba(255,196,229,${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.1 + (index % 3) * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFood(point, time) {
  const center = gridCenter(point);
  const size = Math.min(10.5, state.cell * 0.44);
  const pulse = 1 + Math.sin(time * 0.006 + point.x + point.y) * 0.08;
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(time * 0.00045 + (point.x - point.y) * 0.08);
  ctx.scale(pulse, pulse);
  ctx.shadowColor = "#ff72b6";
  ctx.shadowBlur = 15;
  ctx.fillStyle = "#ff86c3";
  for (let petal = 0; petal < 5; petal += 1) {
    ctx.save();
    ctx.rotate(petal * Math.PI * 2 / 5);
    ctx.beginPath();
    ctx.ellipse(0, -size * 0.48, size * 0.31, size * 0.56, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = "#fff0a7";
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.27, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawPlayer(player) {
  if (!player.snake?.length) return;
  const direction = player.direction || { x: 1, y: 0 };

  player.snake.slice().reverse().forEach((part, reverseIndex) => {
    const index = player.snake.length - 1 - reverseIndex;
    const isHead = index === 0;
    const x = state.offsetX + part.x * state.cell + state.cell * 0.1;
    const y = state.offsetY + part.y * state.cell + state.cell * 0.1;
    const size = state.cell * 0.8;

    ctx.save();
    ctx.globalAlpha = player.alive ? 1 : 0.22;
    ctx.shadowColor = player.color;
    ctx.shadowBlur = isHead ? 16 : 6;
    ctx.fillStyle = player.color;
    roundedRect(x, y, size, size, isHead ? state.cell * 0.28 : state.cell * 0.22);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,.16)";
    roundedRect(x + size * 0.15, y + size * 0.14, size * 0.7, size * 0.15, size * 0.08);
    ctx.fill();

    if (isHead) {
      const perpendicular = { x: -direction.y, y: direction.x };
      const center = gridCenter(part);
      ctx.shadowBlur = 0;
      for (const side of [-1, 1]) {
        const eyeX = center.x + direction.x * state.cell * 0.16 + perpendicular.x * side * state.cell * 0.18;
        const eyeY = center.y + direction.y * state.cell * 0.16 + perpendicular.y * side * state.cell * 0.18;
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(eyeX, eyeY, Math.max(2, state.cell * 0.11), 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#24102e";
        ctx.beginPath();
        ctx.arc(eyeX + direction.x * state.cell * 0.035, eyeY + direction.y * state.cell * 0.035, Math.max(1, state.cell * 0.05), 0, Math.PI * 2);
        ctx.fill();
      }

      if (state.cell >= 13) {
        ctx.font = `700 ${Math.max(10, state.cell * 0.42)}px Inter, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = "rgba(0,0,0,.78)";
        ctx.fillText(player.name, center.x + 1, y - 4 + 1);
        ctx.fillStyle = "#fff8ff";
        ctx.fillText(player.name, center.x, y - 4);
      }
    }
    ctx.restore();
  });
}

function roundedRect(x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function gridCenter(point) {
  return {
    x: state.offsetX + point.x * state.cell + state.cell / 2,
    y: state.offsetY + point.y * state.cell + state.cell / 2
  };
}

function sanitizeName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(String(value || "").replace(/[^#a-zA-Z0-9(),.%\s-]/g, ""));
}

function ensureAudio() {
  if (!state.soundEnabled) return null;
  if (!state.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) state.audioContext = new AudioContextClass();
  }
  if (state.audioContext?.state === "suspended") state.audioContext.resume();
  return state.audioContext;
}

function playTone(frequency, duration, type = "sine", volume = 0.025, delay = 0) {
  const audio = ensureAudio();
  if (!audio) return;
  const start = audio.currentTime + delay;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function playFoodSoundIfNeeded() {
  const key = state.game?.food ? `${state.game.food.x},${state.game.food.y}` : "";
  if (state.lastFoodKey && key && key !== state.lastFoodKey) playTone(720, 0.08, "triangle", 0.02);
  state.lastFoodKey = key;
}

function playEndSound(won) {
  if (won) {
    [660, 830, 1040].forEach((frequency, index) => playTone(frequency, 0.18, "triangle", 0.035, index * 0.075));
  } else {
    playTone(180, 0.22, "sawtooth", 0.018);
  }
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) await $("#gameApp").requestFullscreen();
    else await document.exitFullscreen();
  } catch {
    showToast("瀏覽器沒有允許全螢幕");
  }
}

$("#joinButton").addEventListener("click", joinArena);
$("#nameInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinArena();
});
$("#leaveButton").addEventListener("click", leaveArena);
$("#fullscreenButton").addEventListener("click", toggleFullscreen);
$("#soundButton").addEventListener("click", () => {
  state.soundEnabled = !state.soundEnabled;
  $("#soundButton").textContent = state.soundEnabled ? "🔊" : "🔇";
  if (state.soundEnabled) playTone(560, 0.09, "triangle", 0.03);
});

$$("#touchControls button").forEach((button) => {
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    queueDirection(button.dataset.direction);
  });
});

document.addEventListener("keydown", (event) => {
  const directionMap = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    w: "up",
    W: "up",
    s: "down",
    S: "down",
    a: "left",
    A: "left",
    d: "right",
    D: "right"
  };
  const direction = directionMap[event.key];
  if (!direction) return;
  event.preventDefault();
  queueDirection(direction);
});

document.addEventListener("fullscreenchange", () => {
  $("#fullscreenButton").innerHTML = document.fullscreenElement
    ? '⛶ <span>離開全螢幕</span>'
    : '⛶ <span>全螢幕</span>';
  setTimeout(resizeCanvas, 80);
});

window.addEventListener("resize", resizeCanvas);
window.addEventListener("beforeunload", () => {
  state.manualLeave = true;
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.close(1000, "Page closing");
});

$("#nameInput").value = localStorage.getItem("serverbloom_snake_name") || "";
resizeCanvas();
requestAnimationFrame(renderFrame);
