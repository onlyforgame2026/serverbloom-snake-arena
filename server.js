import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, stat } from "node:fs/promises";
import { SimpleWebSocketServer, WS_OPEN } from "./lib/simple-websocket.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

const PORT = readInt("PORT", 3000, 1, 65535);
const WS_PATH = "/ws";
const COLS = readInt("BOARD_COLS", 72, 36, 120);
const ROWS = readInt("BOARD_ROWS", 40, 24, 80);
const MAX_PLAYERS = readInt("MAX_PLAYERS", 12, 2, 20);
const COUNTDOWN_SECONDS = readInt("COUNTDOWN_SECONDS", 3, 3, 15);
const TICK_MS = readInt("TICK_MS", 125, 70, 300);
const MAX_MESSAGE_BYTES = 2_048;
const MAX_MESSAGES_PER_SECOND = 40;
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const COLORS = [
  "#ff72b6", "#8b5cf6", "#62e6a7", "#ffd45a", "#5ac8fa",
  "#ff8f70", "#b8f05f", "#f58cff", "#8de1ff", "#ff6680",
  "#d8a7ff", "#90f0cf", "#ffb3d9", "#a9a2ff", "#f5e663",
  "#79d6ff", "#ffa36d", "#c4ff8a", "#ff91c8", "#9e7cff"
];

const GOLD_MOVE_EVERY_TICKS = 4;
const GOLD_SCORE_THRESHOLD = 100;
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

const DIRECTIONS = Object.freeze({
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
});

const arena = {
  status: "waiting",
  round: 0,
  mode: "practice",
  players: new Map(),
  food: null,
  countdownEndsAt: 0,
  countdownLastValue: null,
  tickTimer: null,
  countdownTimer: null,
  lastResult: null,
  tickCount: 0,
  totalScore: 0,
  nextGoldAt: GOLD_SCORE_THRESHOLD
};

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        service: "ServerBloom Snake Arena",
        status: arena.status,
        round: arena.round,
        connectedPlayers: arena.players.size,
        maxPlayers: MAX_PLAYERS,
        websocketPath: WS_PATH
      });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { ok: false, error: "Method not allowed" });
      return;
    }

    await serveStatic(requestUrl.pathname, request.method === "HEAD", response);
  } catch (error) {
    console.error("HTTP error:", error);
    sendJson(response, 500, { ok: false, error: "Internal server error" });
  }
});

const wss = new SimpleWebSocketServer({ maxPayload: MAX_MESSAGE_BYTES });

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const origin = request.headers.origin || "";

  if (requestUrl.pathname !== WS_PATH || !isAllowedOrigin(origin, request)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (websocket) => {
    wss.emit("connection", websocket, request);
  });
});

wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.playerId = null;
  socket.rateWindowStart = Date.now();
  socket.rateCount = 0;

  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      socket.close(1003, "Binary messages are not supported");
      return;
    }

    if (rateLimitExceeded(socket)) {
      socket.close(1008, "Too many messages");
      return;
    }

    handleMessage(socket, raw);
  });

  socket.on("close", () => {
    removePlayer(socket.playerId, "斷線");
  });

  socket.on("error", () => {
    // Cleanup is handled by the close event.
  });

  send(socket, {
    type: "hello",
    protocol: 1,
    cols: COLS,
    rows: ROWS,
    maxPlayers: MAX_PLAYERS,
    countdownSeconds: COUNTDOWN_SECONDS,
    tickMs: TICK_MS
  });
});

const heartbeatTimer = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);
heartbeatTimer.unref();

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`ServerBloom Snake Arena listening on http://0.0.0.0:${PORT}`);
  });
}

function handleMessage(socket, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString("utf8"));
  } catch {
    send(socket, { type: "error", code: "BAD_JSON", message: "訊息格式錯誤" });
    return;
  }

  if (!message || typeof message.type !== "string") return;

  switch (message.type) {
    case "join":
      handleJoin(socket, message);
      break;
    case "direction":
      handleDirection(socket, message.direction);
      break;
    case "ping":
      send(socket, {
        type: "pong",
        sentAt: Number(message.sentAt || 0),
        serverAt: Date.now()
      });
      break;
    case "leave":
      removePlayer(socket.playerId, "離開");
      socket.playerId = null;
      send(socket, { type: "left" });
      break;
    default:
      send(socket, { type: "error", code: "UNKNOWN_ACTION", message: "未知操作" });
  }
}

function handleJoin(socket, message) {
  if (socket.playerId && arena.players.has(socket.playerId)) {
    send(socket, { type: "error", code: "ALREADY_JOINED", message: "你已經在公開戰局中" });
    return;
  }

  if (arena.players.size >= MAX_PLAYERS) {
    send(socket, {
      type: "error",
      code: "ARENA_FULL",
      message: `公開戰局目前已滿（${MAX_PLAYERS} 人），請稍後再試`
    });
    return;
  }

  const name = sanitizeName(message.name);
  if (!name) {
    send(socket, { type: "error", code: "BAD_NAME", message: "請輸入 1～16 字的遊戲名稱" });
    return;
  }

  const id = createId();
  const color = pickColor();
  const player = {
    id,
    socket,
    name,
    color,
    joinedAt: Date.now(),
    status: arena.status === "playing" ? "spectating" : "waiting",
    snake: [],
    direction: { ...DIRECTIONS.right },
    nextDirection: { ...DIRECTIONS.right },
    alive: false,
    score: 0,
    growthColors: [],
    wins: 0,
    deathReason: ""
  };

  socket.playerId = id;
  arena.players.set(id, player);

  send(socket, {
    type: "joined",
    playerId: id,
    status: player.status,
    message: player.status === "spectating"
      ? "本局正在進行，你已進入觀戰，下一局會自動加入。"
      : "已加入唯一公開戰局。"
  });

  if (arena.status === "waiting") {
    beginCountdown();
  } else {
    broadcastArena();
  }
}

function handleDirection(socket, directionName) {
  const player = arena.players.get(socket.playerId);
  const next = DIRECTIONS[String(directionName || "")];

  if (!player || !next || arena.status !== "playing" || !player.alive) return;

  const current = player.direction;
  if (current.x + next.x === 0 && current.y + next.y === 0) return;

  player.nextDirection = { ...next };
}

function beginCountdown() {
  if (arena.players.size === 0) {
    resetArenaToWaiting();
    return;
  }

  stopCountdownTimer();
  stopGameLoop();

  arena.status = "countdown";
  arena.countdownEndsAt = Date.now() + COUNTDOWN_SECONDS * 1000;
  arena.countdownLastValue = null;

  for (const player of arena.players.values()) {
    player.status = "waiting";
    player.alive = false;
    player.snake = [];
    player.growthColors = [];
    player.deathReason = "";
  }

  publishCountdown();
  arena.countdownTimer = setInterval(publishCountdown, 200);
}

function publishCountdown() {
  if (arena.players.size === 0) {
    resetArenaToWaiting();
    return;
  }

  const remaining = Math.max(0, Math.ceil((arena.countdownEndsAt - Date.now()) / 1000));
  if (remaining !== arena.countdownLastValue) {
    arena.countdownLastValue = remaining;
    broadcastArena();
  }

  if (remaining <= 0) {
    stopCountdownTimer();
    startRound();
  }
}

function startRound() {
  const participants = [...arena.players.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .slice(0, MAX_PLAYERS);

  if (participants.length === 0) {
    resetArenaToWaiting();
    return;
  }

  arena.status = "playing";
  arena.round += 1;
  arena.mode = participants.length >= 2 ? "ranked" : "practice";
  arena.lastResult = null;
  arena.tickCount = 0;
  arena.totalScore = 0;
  arena.nextGoldAt = GOLD_SCORE_THRESHOLD;

  const slots = createSpawnSlots(participants.length);
  participants.forEach((player, index) => {
    const slot = slots[index];
    player.direction = { ...slot.direction };
    player.nextDirection = { ...slot.direction };
    player.snake = makeSnake(slot.x, slot.y, slot.direction, 4, player.color);
    player.alive = true;
    player.status = "alive";
    player.score = 0;
    player.growthColors = [];
    player.deathReason = "";
  });

  arena.food = spawnFood(false);
  broadcastState();
  broadcastArena();

  stopGameLoop();
  arena.tickTimer = setInterval(tickGame, TICK_MS);
}

function tickGame() {
  const alivePlayers = [...arena.players.values()].filter((player) => player.alive);

  if (alivePlayers.length === 0) {
    endRound();
    return;
  }

  const plans = new Map();
  const targets = new Map();

  for (const player of alivePlayers) {
    player.direction = { ...player.nextDirection };
    const head = player.snake[0];
    const target = {
      x: head.x + player.direction.x,
      y: head.y + player.direction.y
    };
    const growing = samePoint(target, arena.food);
    const keepingTail = growing || player.growthColors.length > 0;
    plans.set(player.id, { player, head, target, growing, keepingTail });

    const key = pointKey(target);
    if (!targets.has(key)) targets.set(key, []);
    targets.get(key).push(player.id);
  }

  const dead = new Map();

  for (const plan of plans.values()) {
    if (outsideBoard(plan.target)) {
      dead.set(plan.player.id, "撞到邊界");
    }
  }

  for (const ids of targets.values()) {
    if (ids.length > 1) {
      for (const id of ids) dead.set(id, "正面相撞");
    }
  }

  const planList = [...plans.values()];
  for (let i = 0; i < planList.length; i += 1) {
    for (let j = i + 1; j < planList.length; j += 1) {
      const a = planList[i];
      const b = planList[j];
      if (samePoint(a.target, b.head) && samePoint(b.target, a.head)) {
        dead.set(a.player.id, "交叉相撞");
        dead.set(b.player.id, "交叉相撞");
      }
    }
  }

  const occupied = new Map();
  for (const player of alivePlayers) {
    const plan = plans.get(player.id);
    const keepLength = plan?.keepingTail ? player.snake.length : Math.max(0, player.snake.length - 1);
    for (let index = 0; index < keepLength; index += 1) {
      const segment = player.snake[index];
      const key = pointKey(segment);
      if (!occupied.has(key)) occupied.set(key, []);
      occupied.get(key).push({ playerId: player.id, index });
    }
  }

  for (const plan of plans.values()) {
    if (dead.has(plan.player.id)) continue;
    const hits = occupied.get(pointKey(plan.target));
    if (hits?.length) {
      dead.set(plan.player.id, hits.some((hit) => hit.playerId === plan.player.id)
        ? "撞到自己"
        : "撞到其他玩家");
    }
  }

  let foodWasEaten = false;
  let spawnGold = false;

  for (const plan of plans.values()) {
    const player = plan.player;
    if (dead.has(player.id)) {
      player.alive = false;
      player.status = "dead";
      player.deathReason = dead.get(player.id);
      continue;
    }

    if (plan.growing) {
      const effect = foodEffect(arena.food);
      player.score += effect.score;
      arena.totalScore += effect.score;

      for (let index = 0; index < effect.growth; index += 1) {
        player.growthColors.push(effect.color);
      }

      while (arena.totalScore >= arena.nextGoldAt) {
        spawnGold = true;
        arena.nextGoldAt += GOLD_SCORE_THRESHOLD;
      }

      foodWasEaten = true;
    }

    player.snake = moveColoredSnake(
      player.snake,
      plan.target,
      player.growthColors,
      player.color
    );
  }

  arena.tickCount += 1;
  if (foodWasEaten) {
    arena.food = spawnFood(spawnGold);
  } else if (arena.food?.type === "gold" && arena.tickCount % GOLD_MOVE_EVERY_TICKS === 0) {
    moveGoldenFood();
  }

  broadcastState();

  const survivors = [...arena.players.values()].filter((player) => player.alive);
  if (arena.mode === "ranked" && survivors.length <= 1) {
    endRound();
  } else if (arena.mode === "practice" && survivors.length === 0) {
    endRound();
  }
}

function endRound() {
  if (arena.status !== "playing") return;
  stopGameLoop();

  const survivors = [...arena.players.values()].filter((player) => player.alive);
  const winner = arena.mode === "ranked" && survivors.length === 1 ? survivors[0] : null;
  if (winner) winner.wins += 1;

  const rankedPlayers = [...arena.players.values()]
    .map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      score: player.score,
      wins: player.wins,
      alive: player.alive,
      deathReason: player.deathReason
    }))
    .sort((a, b) => Number(b.alive) - Number(a.alive) || b.score - a.score || b.wins - a.wins);

  const resultText = arena.mode === "practice"
    ? "練習結束，不計正式勝負"
    : winner
      ? `${winner.name} 成為最後生還者！`
      : "本局沒有生還者";

  arena.lastResult = {
    round: arena.round,
    mode: arena.mode,
    ranked: arena.mode === "ranked",
    winnerId: winner?.id || null,
    resultText,
    players: rankedPlayers
  };

  broadcast({ type: "game_over", ...arena.lastResult });
  beginCountdown();
}

function removePlayer(playerId, reason) {
  if (!playerId) return;
  const player = arena.players.get(playerId);
  if (!player) return;

  const wasAlive = player.alive;
  arena.players.delete(playerId);
  if (player.socket) player.socket.playerId = null;

  if (arena.players.size === 0) {
    resetArenaToWaiting();
    return;
  }

  if (arena.status === "playing" && wasAlive) {
    player.alive = false;
    player.deathReason = reason;
    const survivors = [...arena.players.values()].filter((item) => item.alive);
    if ((arena.mode === "ranked" && survivors.length <= 1) || (arena.mode === "practice" && survivors.length === 0)) {
      endRound();
      return;
    }
  }

  broadcastArena();
  if (arena.status === "playing") broadcastState();
}

function resetArenaToWaiting() {
  stopGameLoop();
  stopCountdownTimer();
  arena.status = "waiting";
  arena.mode = "practice";
  arena.food = null;
  arena.countdownEndsAt = 0;
  arena.countdownLastValue = null;
  arena.lastResult = null;
  arena.tickCount = 0;
  arena.totalScore = 0;
  arena.nextGoldAt = GOLD_SCORE_THRESHOLD;
  broadcastArena();
}

function broadcastArena() {
  const countdown = arena.status === "countdown"
    ? Math.max(0, Math.ceil((arena.countdownEndsAt - Date.now()) / 1000))
    : null;

  broadcast({
    type: "arena",
    status: arena.status,
    round: arena.round,
    mode: arena.mode,
    countdown,
    connected: arena.players.size,
    maxPlayers: MAX_PLAYERS,
    players: serializePlayers(false),
    lastResult: arena.lastResult
  });
}

function broadcastState() {
  broadcast({
    type: "state",
    status: arena.status,
    round: arena.round,
    mode: arena.mode,
    cols: COLS,
    rows: ROWS,
    food: arena.food,
    totalScore: arena.totalScore,
    nextGoldAt: arena.nextGoldAt,
    players: serializePlayers(true),
    serverTime: Date.now()
  });
}

function serializePlayers(includeSnake) {
  return [...arena.players.values()].map((player) => {
    const data = {
      id: player.id,
      name: player.name,
      color: player.color,
      status: player.status,
      alive: player.alive,
      score: player.score,
      wins: player.wins,
      deathReason: player.deathReason
    };
    if (includeSnake) {
      data.snake = player.snake;
      data.direction = player.direction;
    }
    return data;
  });
}

function broadcast(payload) {
  const encoded = JSON.stringify(payload);
  for (const player of arena.players.values()) {
    if (player.socket.readyState === WS_OPEN) {
      player.socket.send(encoded);
    }
  }
}

function send(socket, payload) {
  if (socket.readyState === WS_OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function createSpawnSlots(count) {
  const slots = [];
  const lanesPerSide = Math.ceil(count / 4);
  const horizontalMargin = Math.max(6, Math.min(10, Math.floor(COLS * 0.12)));
  const verticalMargin = Math.max(6, Math.min(9, Math.floor(ROWS * 0.16)));

  for (let lane = 0; lane < lanesPerSide; lane += 1) {
    const y = Math.max(4, Math.min(ROWS - 5, Math.round((lane + 1) * ROWS / (lanesPerSide + 1))));
    const x = Math.max(4, Math.min(COLS - 5, Math.round((lane + 1) * COLS / (lanesPerSide + 1))));

    slots.push({ x: horizontalMargin, y, direction: DIRECTIONS.right });
    slots.push({ x: COLS - horizontalMargin - 1, y: ROWS - 1 - y, direction: DIRECTIONS.left });
    slots.push({ x, y: verticalMargin, direction: DIRECTIONS.down });
    slots.push({ x: COLS - 1 - x, y: ROWS - verticalMargin - 1, direction: DIRECTIONS.up });
  }

  return slots.slice(0, count);
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

function spawnFood(forceGold = false) {
  const occupied = occupiedCells();
  const point = findFreePoint(occupied);
  const effect = forceGold ? FOOD_TYPES.gold : pickNormalFoodType();

  return {
    ...point,
    id: createId(),
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

function moveGoldenFood() {
  const food = arena.food;
  if (!food || food.type !== "gold") return;

  const occupied = occupiedCells();
  const directions = shuffleDirections(food.direction);

  for (const direction of directions) {
    const target = {
      x: food.x + direction.x,
      y: food.y + direction.y
    };
    if (outsideBoard(target) || occupied.has(pointKey(target))) continue;
    food.x = target.x;
    food.y = target.y;
    food.direction = { ...direction };
    return;
  }

  food.direction = randomDirection();
}

function pickNormalFoodType() {
  const roll = Math.random();
  let accumulated = 0;

  for (const effect of Object.values(FOOD_TYPES)) {
    if (effect.type === "gold") continue;
    accumulated += effect.weight;
    if (roll < accumulated) return effect;
  }

  return FOOD_TYPES.pink;
}

function foodEffect(food) {
  const fallback = FOOD_TYPES[String(food?.type || "pink")] || FOOD_TYPES.pink;
  return {
    ...fallback,
    color: String(food?.color || fallback.color),
    score: Number(food?.score || fallback.score),
    growth: Number(food?.growth || fallback.growth)
  };
}

function occupiedCells() {
  const occupied = new Set();
  for (const player of arena.players.values()) {
    for (const segment of player.snake) occupied.add(pointKey(segment));
  }
  return occupied;
}

function findFreePoint(occupied) {
  const attempts = COLS * ROWS;
  for (let index = 0; index < attempts; index += 1) {
    const point = {
      x: 2 + Math.floor(Math.random() * Math.max(1, COLS - 4)),
      y: 2 + Math.floor(Math.random() * Math.max(1, ROWS - 4))
    };
    if (!occupied.has(pointKey(point))) return point;
  }

  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLS; x += 1) {
      const point = { x, y };
      if (!occupied.has(pointKey(point))) return point;
    }
  }

  return { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) };
}

function randomDirection() {
  const directions = Object.values(DIRECTIONS);
  return { ...directions[Math.floor(Math.random() * directions.length)] };
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

function pickColor() {
  const used = new Set([...arena.players.values()].map((player) => player.color));
  return COLORS.find((color) => !used.has(color)) || COLORS[arena.players.size % COLORS.length];
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

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function samePoint(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y);
}

function pointKey(point) {
  return `${point.x},${point.y}`;
}

function outsideBoard(point) {
  return point.x < 0 || point.y < 0 || point.x >= COLS || point.y >= ROWS;
}

function stopGameLoop() {
  if (arena.tickTimer) clearInterval(arena.tickTimer);
  arena.tickTimer = null;
}

function stopCountdownTimer() {
  if (arena.countdownTimer) clearInterval(arena.countdownTimer);
  arena.countdownTimer = null;
}

function rateLimitExceeded(socket) {
  const now = Date.now();
  if (now - socket.rateWindowStart >= 1000) {
    socket.rateWindowStart = now;
    socket.rateCount = 0;
  }
  socket.rateCount += 1;
  return socket.rateCount > MAX_MESSAGES_PER_SECOND;
}

function isAllowedOrigin(origin, request) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes("*")) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;

  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || "http";
  const host = request.headers.host || "";
  return origin === `${protocol}://${host}`;
}

async function serveStatic(pathname, headOnly, response) {
  const requestedPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  const normalized = path.normalize(requestedPath).replace(/^([.][.][/\\])+/, "");
  const relative = normalized.replace(/^[/\\]+/, "");
  const filePath = path.join(PUBLIC_DIR, relative);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(response, 403, { ok: false, error: "Forbidden" });
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    const content = headOnly ? Buffer.alloc(0) : await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeType(filePath),
      "content-length": headOnly ? info.size : content.length,
      "cache-control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "content-security-policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors *"
    });
    response.end(content);
  } catch {
    sendJson(response, 404, { ok: false, error: "Not found" });
  }
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon"
  }[extension] || "application/octet-stream";
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

function readInt(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function shutdown() {
  stopGameLoop();
  stopCountdownTimer();
  clearInterval(heartbeatTimer);
  for (const socket of wss.clients) socket.close(1001, "Server shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

if (isMainModule) {
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export {
  DIRECTIONS,
  sanitizeName,
  samePoint,
  makeSnake,
  outsideBoard
};
