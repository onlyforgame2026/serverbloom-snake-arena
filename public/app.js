"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const canvas = $("#gameCanvas");
const ctx = canvas.getContext("2d");

const DEFAULT_PUBLIC_SERVER = "wss://serverbloom-snake-arena.onrender.com/ws";
const LOCAL_TICK_MS = 125;
const GOLD_MOVE_EVERY_TICKS = 4;
const GOLD_SCORE_THRESHOLD = 100;

const DIRECTIONS = Object.freeze({
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
});

const FOOD_TYPES = Object.freeze({
  pink: {
    type: "pink",
    label: "淡粉櫻花",
    color: "#ffb7d5",
    center: "#fff0f7",
    score: 5,
    growth: 1,
    moving: false,
    weight: 0.4
  },
  gray: {
    type: "gray",
    label: "灰色櫻花",
    color: "#9ca3af",
    center: "#f3f4f6",
    score: 10,
    growth: 1,
    moving: false,
    weight: 0.25
  },
  lavender: {
    type: "lavender",
    label: "淡紫櫻花",
    color: "#c9b3ff",
    center: "#fff6ff",
    score: 10,
    growth: 1,
    moving: false,
    weight: 0.2
  },
  purple: {
    type: "purple",
    label: "深紫櫻花",
    color: "#6d28d9",
    center: "#eadcff",
    score: 20,
    growth: 1,
    moving: false,
    weight: 0.15
  },
  gold: {
    type: "gold",
    label: "金色櫻花",
    color: "#f6c453",
    center: "#fff4b8",
    score: 3,
    growth: 3,
    moving: true,
    weight: 0
  }
});

const state = {
  mode: "menu",
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
  lastFoodKey: "",
  publicVisualColors: new Map(),
  local: {
    timer: null,
    running: false,
    snake: [],
    direction: { ...DIRECTIONS.right },
    nextDirection: { ...DIRECTIONS.right },
    score: 0,
    color: FOOD_TYPES.lavender.color,
    food: null,
    growthColors: [],
    nextGoldAt: GOLD_SCORE_THRESHOLD,
    tickCount: 0,
    round: 0
  }
};

function websocketUrl() {
  const supplied = new URLSearchParams(location.search).get("server");
  if (supplied) {
    try {
      const parsed = new URL(supplied);
      if (parsed.protocol === "ws:" || parsed.protocol === "wss:") return parsed.toString();
    } catch {
      // Use the normal default below.
    }
  }

  if (location.hostname.endsWith("github.io")) return DEFAULT_PUBLIC_SERVER;

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

function openPublicJoin() {
  stopLocalGame();
  closeSocket(false);
  state.mode = "public";
  state.manualLeave = true;
  resetSharedGameState();
  setConnection("idle", "尚未連線");
  $("#latencyText").textContent = "—";
  $("#modeLabel").textContent = "唯一公開戰局";
  setStatus("輸入名稱後加入唯一公開戰局。");
  showOverlay("publicJoin");
  setTimeout(() => $("#nameInput").focus(), 80);
}

function startSinglePractice() {
  state.manualLeave = true;
  closeSocket(true);
  resetSharedGameState();
  stopLocalGame();

  state.mode = "single";
  state.local.round += 1;
  state.local.running = true;
  state.local.direction = { ...DIRECTIONS.right };
  state.local.nextDirection = { ...DIRECTIONS.right };
  state.local.score = 0;
  state.local.color = FOOD_TYPES.lavender.color;
  state.local.growthColors = [];
  state.local.nextGoldAt = GOLD_SCORE_THRESHOLD;
  state.local.tickCount = 0;

  const startX = Math.max(8, Math.floor(state.cols * 0.3));
  const startY = Math.floor(state.rows / 2);
  state.local.snake = makeSnake(startX, startY, DIRECTIONS.right, 4, state.local.color);
  state.local.food = spawnLocalFood();

  syncLocalState();
  $("#leaveButton").hidden = false;
  $("#playerList").hidden = true;
  $("#spectatorBanner").hidden = true;
  $("#touchControls").hidden = false;
  $("#modeLabel").textContent = `單人練習・第 ${state.local.round} 局`;
  setConnection("local", "本機模式");
  $("#latencyText").textContent = "離線";
  setStatus("淡粉 5 分｜灰色 10 分｜淡紫 10 分｜深紫 20 分；累積滿 100 分出現會移動的金色櫻花。");
  showOverlay("none");

  clearInterval(state.local.timer);
  state.local.timer = setInterval(tickLocalGame, LOCAL_TICK_MS);
}

function tickLocalGame() {
  if (!state.local.running || state.mode !== "single") return;

  const local = state.local;
  const proposed = local.nextDirection;
  if (!isOpposite(local.direction, proposed)) local.direction = { ...proposed };

  const head = local.snake[0];
  const target = {
    x: head.x + local.direction.x,
    y: head.y + local.direction.y
  };

  const ateFood = samePoint(target, local.food);
  const willGrow = ateFood || local.growthColors.length > 0;
  const bodyToCheck = willGrow ? local.snake : local.snake.slice(0, -1);

  if (outsideBoard(target) || bodyToCheck.some((segment) => samePoint(segment, target))) {
    endSinglePractice(outsideBoard(target) ? "撞到邊界" : "撞到自己");
    return;
  }

  if (ateFood) {
    const effect = foodEffect(local.food);
    local.score += effect.score;
    local.color = effect.color;

    for (let index = 0; index < effect.growth; index += 1) {
      local.growthColors.push(effect.color);
    }

    let spawnGold = false;
    while (local.score >= local.nextGoldAt) {
      spawnGold = true;
      local.nextGoldAt += GOLD_SCORE_THRESHOLD;
    }

    showToast(`${effect.label}：+${effect.score} 分・新增 ${effect.growth} 節${effect.type === "gold" ? "金色" : ""}蛇身`);
    playFoodTone(effect.type);
    local.food = spawnLocalFood(spawnGold);
  }

  local.snake = moveColoredSnake(
    local.snake,
    target,
    local.growthColors,
    local.color
  );

  local.tickCount += 1;
  if (local.food?.type === "gold" && local.tickCount % GOLD_MOVE_EVERY_TICKS === 0) {
    moveGoldenFood();
  }

  syncLocalState();
}

function endSinglePractice(reason) {
  stopLocalGame();
  const local = state.local;
  syncLocalState(false);
  $("#resultIcon").textContent = "🌸";
  $("#resultTitle").textContent = "單人練習結束";
  $("#resultMessage").textContent = `${reason}。本局不計排名與勝場。`;
  $("#resultTable").innerHTML = `
    <div class="result-row">
      <span class="result-rank">#1</span>
      <span class="player-color" style="--player-color:${escapeAttribute(local.color)}"></span>
      <span class="result-name">你</span>
      <span class="result-score">${local.score} 分・長度 ${local.snake.length}</span>
    </div>`;
  $("#nextRoundChip").hidden = true;
  $("#singleResultActions").hidden = false;
  $("#touchControls").hidden = true;
  setStatus(`單人練習結束：${reason}。`);
  showOverlay("result");
  playEndSound(false);
}

function stopLocalGame() {
  clearInterval(state.local.timer);
  state.local.timer = null;
  state.local.running = false;
}

function syncLocalState(alive = true) {
  const local = state.local;
  state.playerId = "local-player";
  state.game = {
    status: local.running ? "playing" : "ended",
    round: local.round,
    mode: "practice",
    cols: state.cols,
    rows: state.rows,
    food: local.food,
    players: [{
      id: "local-player",
      name: "你",
      color: local.color,
      displayColor: local.color,
      status: alive ? "alive" : "dead",
      alive,
      score: local.score,
      wins: 0,
      snake: local.snake,
      direction: local.direction
    }]
  };

  $("#myScore").textContent = local.score;
  $("#myWins").textContent = "0";
  $("#aliveCount").textContent = alive ? "1 / 1" : "0 / 1";
}

function spawnLocalFood(forceGold = false) {
  const effect = forceGold ? FOOD_TYPES.gold : pickNormalFoodType();
  const occupied = new Set(state.local.snake.map(pointKey));
  const point = findFreePoint(occupied);
  return {
    ...point,
    id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    type: effect.type,
    label: effect.label,
    color: effect.color,
    center: effect.center,
    score: effect.score,
    growth: effect.growth,
    moving: effect.moving,
    direction: effect.moving ? randomDirection() : null
  };
}

function pickNormalFoodType() {
  const normalFoods = Object.values(FOOD_TYPES).filter((effect) => effect.type !== "gold");
  const roll = Math.random();
  let accumulated = 0;

  for (const effect of normalFoods) {
    accumulated += effect.weight;
    if (roll < accumulated) return effect;
  }

  return FOOD_TYPES.pink;
}

function moveGoldenFood() {
  const food = state.local.food;
  if (!food || food.type !== "gold") return;

  const occupied = new Set(state.local.snake.map(pointKey));
  const directions = shuffleDirections(food.direction);

  for (const direction of directions) {
    const target = { x: food.x + direction.x, y: food.y + direction.y };
    if (outsideBoard(target) || occupied.has(pointKey(target))) continue;
    food.x = target.x;
    food.y = target.y;
    food.direction = { ...direction };
    return;
  }

  food.direction = randomDirection();
}

function findFreePoint(occupied) {
  const attempts = state.cols * state.rows;
  for (let index = 0; index < attempts; index += 1) {
    const point = {
      x: 2 + Math.floor(Math.random() * Math.max(1, state.cols - 4)),
      y: 2 + Math.floor(Math.random() * Math.max(1, state.rows - 4))
    };
    if (!occupied.has(pointKey(point))) return point;
  }

  for (let y = 0; y < state.rows; y += 1) {
    for (let x = 0; x < state.cols; x += 1) {
      const point = { x, y };
      if (!occupied.has(pointKey(point))) return point;
    }
  }
  return { x: Math.floor(state.cols / 2), y: Math.floor(state.rows / 2) };
}

function joinArena() {
  const name = sanitizeName($("#nameInput").value);
  if (!name) {
    showToast("請先輸入遊戲名稱");
    $("#nameInput").focus();
    return;
  }

  state.mode = "public";
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
  $("#latencyText").textContent = "— ms";

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
    if (state.mode !== "public") return;
    clearInterval(state.pingTimer);
    state.pingTimer = null;
    state.socket = null;
    state.joined = false;
    state.playerId = "";
    setConnection("error", event.code === 1000 ? "已離線" : "連線中斷");

    if (!state.manualLeave && state.desiredName && state.mode === "public") {
      setStatus("連線中斷，正在重新加入公開戰局…");
      state.reconnectTimer = setTimeout(connect, 2200);
    } else if (state.mode === "public") {
      showOverlay("publicJoin");
    }
  });

  state.socket.addEventListener("error", () => {
    setConnection("error", "連線失敗");
    $("#joinButton").disabled = false;
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
      showOverlay("none");
      showToast(String(message.message || "已加入公開戰局"));
      break;

    case "arena":
      state.arena = message;
      renderArena();
      break;

    case "state":
      applyPublicVisualColors(message);
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
      returnToMenu();
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

function applyPublicVisualColors(nextGame) {
  const previousGame = state.game;
  const previousFood = previousGame?.food;
  const previousScores = new Map((previousGame?.players || []).map((player) => [player.id, Number(player.score || 0)]));

  for (const player of nextGame.players || []) {
    const oldScore = previousScores.get(player.id);
    const newScore = Number(player.score || 0);
    if (oldScore !== undefined && newScore > oldScore && previousFood) {
      state.publicVisualColors.set(player.id, foodEffect(previousFood).color);
    }
    const serverColor = String(player.color || "");
    player.displayColor = state.publicVisualColors.get(player.id) || serverColor;
  }
}

function renderArena() {
  if (!state.arena || state.mode !== "public") return;
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
    showOverlay("none");
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
  list.hidden = state.mode !== "public" || !state.joined || players.length === 0;
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
      const color = player.displayColor || state.publicVisualColors.get(player.id) || player.color;
      return `
        <div class="player-row ${player.id === state.playerId ? "me" : ""}">
          <span class="player-color" style="--player-color:${escapeAttribute(color)}"></span>
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
    : "這局是公開戰局內的單人練習，因此不計正式勝負。";

  $("#resultTable").innerHTML = (result.players || []).map((player, index) => {
    const color = state.publicVisualColors.get(player.id) || player.color;
    return `
      <div class="result-row">
        <span class="result-rank">#${index + 1}</span>
        <span class="player-color" style="--player-color:${escapeAttribute(color)}"></span>
        <span class="result-name">${escapeHtml(player.name)}${player.id === state.playerId ? "（你）" : ""}</span>
        <span class="result-score">${Number(player.score || 0)} 分・${Number(player.wins || 0)} 勝</span>
      </div>`;
  }).join("");

  $("#nextRoundChip").hidden = false;
  $("#singleResultActions").hidden = true;
  showOverlay("result");
  playEndSound(won);
}

function showOverlay(name) {
  $("#modeOverlay").hidden = name !== "mode";
  $("#publicJoinOverlay").hidden = name !== "publicJoin";
  $("#waitingOverlay").hidden = name !== "waiting";
  $("#resultOverlay").hidden = name !== "result";
}

function queueDirection(directionName) {
  const next = DIRECTIONS[directionName];
  if (!next) return;

  if (state.mode === "single") {
    if (!state.local.running || isOpposite(state.local.direction, next)) return;
    state.local.nextDirection = { ...next };
    return;
  }

  const me = state.game?.players?.find((player) => player.id === state.playerId);
  if (!me?.alive) return;
  safeSend({ type: "direction", direction: directionName });
}

function leaveCurrentMode() {
  if (state.mode === "single") {
    stopLocalGame();
    returnToMenu();
    return;
  }

  if (state.mode === "public") {
    state.manualLeave = true;
    safeSend({ type: "leave" });
    setTimeout(() => closeSocket(true), 100);
    returnToMenu();
  }
}

function returnToMenu() {
  stopLocalGame();
  state.manualLeave = true;
  clearTimeout(state.reconnectTimer);
  closeSocket(true);
  state.mode = "menu";
  resetSharedGameState();
  $("#leaveButton").hidden = true;
  $("#playerList").hidden = true;
  $("#spectatorBanner").hidden = true;
  $("#touchControls").hidden = true;
  $("#joinButton").disabled = false;
  $("#modeLabel").textContent = "選擇遊戲模式";
  $("#myScore").textContent = "0";
  $("#aliveCount").textContent = "0 / 0";
  $("#myWins").textContent = "0";
  setConnection("idle", "尚未選擇模式");
  $("#latencyText").textContent = "—";
  setStatus("選擇單人練習，或進入唯一公開戰局。");
  showOverlay("mode");
}

function resetSharedGameState() {
  state.joined = false;
  state.playerId = "";
  state.arena = null;
  state.game = null;
  state.result = null;
  state.lastFoodKey = "";
  state.publicVisualColors.clear();
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
  pill.classList.remove("online", "local", "error");
  if (status === "online") pill.classList.add("online");
  if (status === "local") pill.classList.add("local");
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
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2400);
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
  const effect = foodEffect(point);
  const center = gridCenter(point);
  const size = Math.min(10.5, state.cell * 0.44);
  const pulse = 1 + Math.sin(time * 0.006 + point.x + point.y) * (effect.type === "gold" ? 0.14 : 0.08);

  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(time * (effect.type === "gold" ? 0.0011 : 0.00045) + (point.x - point.y) * 0.08);
  ctx.scale(pulse, pulse);
  ctx.shadowColor = effect.color;
  ctx.shadowBlur = effect.type === "gold" ? 24 : 15;
  ctx.fillStyle = effect.color;

  for (let petal = 0; petal < 5; petal += 1) {
    ctx.save();
    ctx.rotate(petal * Math.PI * 2 / 5);
    ctx.beginPath();
    ctx.ellipse(0, -size * 0.48, size * 0.31, size * 0.56, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  ctx.fillStyle = effect.center;
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.27, 0, Math.PI * 2);
  ctx.fill();

  if (effect.type === "gold") {
    ctx.strokeStyle = "rgba(255,255,255,.72)";
    ctx.lineWidth = Math.max(1, state.cell * 0.06);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.78, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPlayer(player) {
  if (!player.snake?.length) return;
  const direction = player.direction || { x: 1, y: 0 };
  const playerColor = player.displayColor || state.publicVisualColors.get(player.id) || player.color || FOOD_TYPES.pink.color;

  player.snake.slice().reverse().forEach((part, reverseIndex) => {
    const index = player.snake.length - 1 - reverseIndex;
    const isHead = index === 0;
    const x = state.offsetX + part.x * state.cell + state.cell * 0.1;
    const y = state.offsetY + part.y * state.cell + state.cell * 0.1;
    const size = state.cell * 0.8;

    const segmentColor = String(part.color || playerColor);

    ctx.save();
    ctx.globalAlpha = player.alive ? 1 : 0.22;
    ctx.shadowColor = segmentColor;
    ctx.shadowBlur = isHead ? 16 : 6;
    ctx.fillStyle = segmentColor;
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

      if (state.cell >= 13 && player.name) {
        ctx.font = `700 ${Math.max(10, state.cell * 0.42)}px Inter, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = "rgba(0,0,0,.78)";
        ctx.fillText(player.name, center.x + 1, y - 3);
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

function foodEffect(food) {
  const type = String(food?.type || "pink");
  const fallback = FOOD_TYPES[type] || FOOD_TYPES.pink;
  return {
    ...fallback,
    color: String(food?.color || fallback.color),
    center: String(food?.center || fallback.center),
    score: Number(food?.score || fallback.score),
    growth: Number(food?.growth || fallback.growth),
    moving: Boolean(food?.moving ?? fallback.moving)
  };
}

function makeSnake(headX, headY, direction, length, color = null) {
  const snake = [];
  for (let index = 0; index < length; index += 1) {
    const segment = {
      x: headX - direction.x * index,
      y: headY - direction.y * index
    };
    if (color) segment.color = color;
    snake.push(segment);
  }
  return snake;
}

function moveColoredSnake(snake, target, growthColors, fallbackColor) {
  const oldColors = snake.map((segment) => String(segment.color || fallbackColor));
  const shouldGrow = growthColors.length > 0;
  const nextPositions = shouldGrow
    ? [{ x: target.x, y: target.y }, ...snake.map(({ x, y }) => ({ x, y }))]
    : [{ x: target.x, y: target.y }, ...snake.slice(0, -1).map(({ x, y }) => ({ x, y }))];

  const nextColors = oldColors.slice();
  if (shouldGrow) nextColors.push(String(growthColors.shift() || fallbackColor));

  return nextPositions.map((segment, index) => ({
    ...segment,
    color: nextColors[index] || fallbackColor
  }));
}

function randomDirection() {
  const values = Object.values(DIRECTIONS);
  return { ...values[Math.floor(Math.random() * values.length)] };
}

function shuffleDirections(preferred) {
  const others = Object.values(DIRECTIONS)
    .filter((direction) => !sameDirection(direction, preferred))
    .sort(() => Math.random() - 0.5);
  return preferred ? [preferred, ...others] : others;
}

function sameDirection(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y);
}

function isOpposite(a, b) {
  return Boolean(a && b && a.x + b.x === 0 && a.y + b.y === 0);
}

function samePoint(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y);
}

function pointKey(point) {
  return `${point.x},${point.y}`;
}

function outsideBoard(point) {
  return point.x < 0 || point.y < 0 || point.x >= state.cols || point.y >= state.rows;
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

function playFoodTone(type) {
  if (type === "gold") {
    [760, 980, 1240].forEach((frequency, index) => playTone(frequency, 0.13, "triangle", 0.032, index * 0.045));
    return;
  }
  const frequencies = { pink: 720, gray: 540, lavender: 790, purple: 650 };
  playTone(frequencies[type] || 720, 0.09, "triangle", 0.022);
}

function playFoodSoundIfNeeded() {
  const food = state.game?.food;
  const key = food ? String(food.id || `${food.x},${food.y},${food.type || "pink"}`) : "";
  if (state.lastFoodKey && key && key !== state.lastFoodKey) {
    playFoodTone(food?.type || "pink");
  }
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

$("#singleModeButton").addEventListener("click", startSinglePractice);
$("#publicModeButton").addEventListener("click", openPublicJoin);
$("#publicBackButton").addEventListener("click", returnToMenu);
$("#joinButton").addEventListener("click", joinArena);
$("#nameInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinArena();
});
$("#leaveButton").addEventListener("click", leaveCurrentMode);
$("#singleRestartButton").addEventListener("click", startSinglePractice);
$("#singleMenuButton").addEventListener("click", returnToMenu);
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
  stopLocalGame();
  state.manualLeave = true;
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.close(1000, "Page closing");
});

$("#nameInput").value =
  localStorage.getItem("serverbloom_snake_name") || "sakura";
resizeCanvas();
returnToMenu();
requestAnimationFrame(renderFrame);
