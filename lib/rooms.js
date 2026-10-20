"use strict";

const crypto = require("crypto");
const realJudge = require("./judge");
const fakeJudge = require("../test/fake-judge");

// Read at call time: on Cloudflare the environment is filled in after modules load.
const judge = () => (process.env.NTG_FAKE_JUDGE ? fakeJudge : realJudge);

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O: too easy to confuse with 1 and 0
const MAX_PLAYERS = 12;
const DISCONNECT_GRACE_MS = 15000;
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 20000;

const rooms = new Map();

class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function cleanText(v, max) {
  return typeof v === "string" ? v.replace(/[|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function newCode() {
  for (;;) {
    let code = "";
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
}

function newPlayer(name) {
  return {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(24).toString("base64url"),
    name,
    out: false,
    left: false,
    connections: 0,
    graceTimer: null,
  };
}

function validName(raw) {
  const name = cleanText(raw, 24);
  if (!name) throw new GameError("Enter your name.");
  return name;
}

// ---------- Room lifecycle ----------

function createRoom(rawName) {
  const host = newPlayer(validName(rawName));
  const room = {
    code: newCode(),
    hostId: host.id,
    players: [host],
    phase: "lobby",             // lobby | playing | over
    topic: "",
    seconds: 15,
    starting: false,
    current: 0,
    answers: [],                // { typed, title, description, by }
    eliminated: [],             // { name, reason }
    timer: null,
    deadline: 0,
    remainingMs: 0,
    paused: false,
    checking: null,             // { typed, by } while the answer is being judged
    turnToken: 0,
    event: null,                // { seq, kind, text } latest message for everyone
    eventSeq: 0,
    clients: new Set(),
    emptySince: Date.now(),
  };
  rooms.set(room.code, room);
  startHeartbeat();
  return { room, player: host };
}

function getRoom(rawCode) {
  const code = String(rawCode || "").toUpperCase();
  const room = rooms.get(code);
  if (!room) throw new GameError(`Room ${code || "?"} doesn't exist. Check the code.`, 404);
  return room;
}

function joinRoom(rawCode, rawName) {
  const room = getRoom(rawCode);
  const name = validName(rawName);
  if (room.phase !== "lobby") throw new GameError("That game has already started. Ask the host to go back to the lobby.", 409);
  if (room.players.length >= MAX_PLAYERS) throw new GameError("That room is full.", 409);
  if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    throw new GameError(`Someone in that room is already called "${name}".`, 409);
  }
  const player = newPlayer(name);
  room.players.push(player);
  setEvent(room, "info", `${name} joined.`);
  broadcast(room);
  return { room, player };
}

function auth(room, token) {
  const player = room.players.find((p) => p.token === token && !p.left);
  if (!player) throw new GameError("You're not in this room anymore.", 403);
  return player;
}

function deleteRoom(room) {
  clearTimer(room);
  for (const p of room.players) clearTimeout(p.graceTimer);
  rooms.delete(room.code);
  const clients = [...room.clients];
  room.clients.clear();
  for (const c of clients) c.conn.end();
}

function removePlayer(room, player) {
  const idx = room.players.indexOf(player);
  if (idx === -1) return;
  clearTimeout(player.graceTimer);
  room.players.splice(idx, 1);
  if (room.players.length === 0) return deleteRoom(room);
  if (room.hostId === player.id) handOffHost(room);
}

function handOffHost(room) {
  const next =
    room.players.find((p) => !p.left && p.connections > 0) ||
    room.players.find((p) => !p.left);
  if (!next) return deleteRoom(room);
  room.hostId = next.id;
  setEvent(room, "info", `${next.name} is now the host.`);
}

// ---------- Live updates ----------
// conn: { ended, send(json), ping(), end(), onClose(fn) }, backed by Server-Sent Events (server.js)
// or a WebSocket (worker/index.js). onClose fires once, including after end().

function attachClient(room, player, conn) {
  const client = { conn, playerId: player.id };
  room.clients.add(client);
  player.connections++;
  clearTimeout(player.graceTimer);
  player.graceTimer = null;
  room.emptySince = null;
  sendState(room, client);
  broadcast(room);

  conn.onClose(() => {
    room.clients.delete(client);
    player.connections = Math.max(0, player.connections - 1);
    if (room.clients.size === 0) room.emptySince = Date.now();
    const stillInRoom = rooms.has(room.code) && room.players.includes(player) && !player.left;
    if (player.connections === 0 && stillInRoom) {
      player.graceTimer = setTimeout(() => onDisconnected(room, player), DISCONNECT_GRACE_MS);
      broadcast(room);
    }
  });
}

function onDisconnected(room, player) {
  player.graceTimer = null;
  if (!rooms.has(room.code) || player.connections > 0 || player.left || !room.players.includes(player)) return;
  if (room.phase === "lobby") {
    setEvent(room, "info", `${player.name} left.`);
    removePlayer(room, player);
  } else {
    if (room.phase === "playing" && !player.out) eliminate(room, room.players.indexOf(player), "disconnected");
    if (room.hostId === player.id) handOffHost(room);
  }
  if (rooms.has(room.code)) broadcast(room);
}

function remainingMs(room) {
  return room.timer ? Math.max(0, room.deadline - Date.now()) : room.remainingMs;
}

function snapshot(room, playerId) {
  const winner = room.phase === "over" ? room.players.find((p) => !p.out && !p.left) : null;
  return {
    code: room.code,
    phase: room.phase,
    you: playerId,
    hostId: room.hostId,
    players: room.players
      .filter((p) => !p.left || room.phase !== "lobby")
      .map((p) => ({ id: p.id, name: p.name, out: p.out, left: p.left, connected: p.connections > 0 })),
    topic: room.topic,
    seconds: room.seconds,
    starting: room.starting,
    currentId: room.phase === "playing" ? room.players[room.current].id : null,
    answers: room.answers,
    eliminated: room.eliminated,
    timer: { running: !!room.timer, remainingMs: remainingMs(room), totalMs: room.seconds * 1000 },
    paused: room.paused,
    checking: room.checking,
    event: room.event,
    winner: winner ? winner.name : null,
    lanOrigin: module.exports.lanOrigin || null,
  };
}

function disconnectClientsOf(room, playerId) {
  for (const c of [...room.clients]) {
    if (c.playerId !== playerId) continue;
    room.clients.delete(c);
    c.conn.end();
  }
}

function sendState(room, client) {
  if (client.conn.ended) return;
  client.conn.send(JSON.stringify(snapshot(room, client.playerId)));
}

function broadcast(room) {
  for (const c of room.clients) sendState(room, c);
}

function setEvent(room, kind, text) {
  room.event = { seq: ++room.eventSeq, kind, text };
}

// Started with the first room: Cloudflare doesn't allow timers while modules load.
let heartbeat = null;
function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      for (const c of room.clients) if (!c.conn.ended) c.conn.ping();
      if (room.clients.size === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) deleteRoom(room);
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
}

// ---------- Turn timer ----------

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function runTimer(room) {
  if (room.seconds === 0 || room.paused) return;
  clearTimer(room);
  room.deadline = Date.now() + room.remainingMs;
  room.timer = setTimeout(() => {
    room.timer = null;
    room.remainingMs = 0;
    if (room.phase === "playing") {
      eliminate(room, room.current, "time's up");
      broadcast(room);
    }
  }, room.remainingMs);
}

function haltTimer(room) {
  if (!room.timer) return;
  room.remainingMs = Math.max(0, room.deadline - Date.now());
  clearTimer(room);
}

function startTurn(room) {
  clearTimer(room);
  room.turnToken++;
  room.checking = null;
  room.remainingMs = room.seconds * 1000;
  runTimer(room);
}

// ---------- Game flow ----------

function activePlayers(room) {
  return room.players.filter((p) => !p.out);
}

function nextActive(room, from) {
  const n = room.players.length;
  for (let step = 1; step <= n; step++) {
    const i = (from + step) % n;
    if (!room.players[i].out) return i;
  }
  return from;
}

function eliminate(room, index, reason) {
  const p = room.players[index];
  if (!p || p.out) return;
  p.out = true;
  room.eliminated.push({ name: p.name, reason });
  setEvent(room, "bad", `${p.name} is out: ${reason}.`);
  if (activePlayers(room).length <= 1) return endGame(room);
  if (index === room.current) room.current = nextActive(room, index);
  startTurn(room);
}

function endGame(room) {
  clearTimer(room);
  room.turnToken++;
  room.checking = null;
  room.paused = false;
  room.phase = "over";
  const winner = activePlayers(room)[0];
  setEvent(room, "good", winner ? `${winner.name} wins!` : "Game over.");
}

function acceptAnswer(room, entry) {
  const player = room.players[room.current];
  room.answers.push({ ...entry, by: player.name });
  const desc = entry.description ? ` (${entry.description})` : "";
  setEvent(room, "good", `✓ ${player.name}: ${entry.title}${desc}`);
  room.current = nextActive(room, room.current);
  startTurn(room);
}

function requireHost(room, player) {
  if (room.hostId !== player.id) throw new GameError("Only the host can do that.", 403);
}

function requirePlaying(room) {
  if (room.phase !== "playing") throw new GameError("The game isn't running.", 409);
}

function requireIdle(room) {
  if (room.checking) throw new GameError("Wait for the current answer to be checked.", 409);
}

async function startGame(room, player, body) {
  requireHost(room, player);
  if (room.phase === "playing") throw new GameError("The game is already running.", 409);
  if (room.starting) throw new GameError("Already starting.", 409);
  const topic = cleanText(body.topic, 80) || room.topic;
  if (!topic) throw new GameError("Pick a topic.");
  const seconds = body.seconds === undefined ? room.seconds : Number(body.seconds);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 300) {
    throw new GameError("Seconds per turn must be a whole number from 0 to 300.");
  }
  const players = room.players.filter((p) => !p.left);
  if (players.length < 2) throw new GameError("You need at least 2 players.");

  room.starting = true;
  broadcast(room);
  let verdict;
  try {
    verdict = await judge().checkTopic(topic);
  } catch (err) {
    throw new GameError(`Couldn't check the topic: ${err.message}.`, 502);
  } finally {
    room.starting = false;
  }
  if (!rooms.has(room.code)) return;
  if (!verdict.ok) {
    broadcast(room);
    throw new GameError(`“${topic}” doesn't work as a topic${verdict.reason ? `: ${verdict.reason}` : "."} Try another.`, 422);
  }

  room.players = room.players.filter((p) => !p.left);
  for (const p of room.players) p.out = false;
  room.topic = topic;
  room.seconds = seconds;
  room.phase = "playing";
  room.current = 0;
  room.answers = [];
  room.eliminated = [];
  room.paused = false;
  setEvent(room, "info", `Game on! ${room.players[0].name} goes first.`);
  startTurn(room);
}

async function submitAnswer(room, player, body) {
  requirePlaying(room);
  requireIdle(room);
  if (room.players[room.current].id !== player.id) throw new GameError("It's not your turn.", 409);
  if (room.paused) throw new GameError("The game is paused.", 409);
  const typed = cleanText(body.answer, 80);
  if (!typed || !/[\p{L}\p{N}]/u.test(typed)) throw new GameError("Type an answer first.");

  haltTimer(room);
  const token = room.turnToken;
  room.checking = { typed, by: player.name };
  broadcast(room);

  let res = null;
  let error = null;
  try {
    res = await judge().checkAnswer(room.topic, typed, room.answers.map((a) => a.title));
  } catch (err) {
    error = err;
  }
  if (!rooms.has(room.code) || room.turnToken !== token || room.phase !== "playing") return;
  room.checking = null;

  if (res && res.result === "correct") {
    acceptAnswer(room, { typed, title: res.title, description: res.description });
    return;
  }
  if (error) {
    setEvent(room, "info", `Couldn't check “${typed}” (${error.message}). Try again, ${player.name}.`);
  } else if (res.result === "duplicate") {
    const prev = room.answers.find((a) => a.title === res.title);
    setEvent(room, "bad", `“${res.title}” was already said${prev ? ` by ${prev.by}` : ""}. Try again, ${player.name}!`);
  } else {
    setEvent(room, "bad", `✗ ${player.name}: ${res.reason}`);
  }
  runTimer(room);
}

const actions = {
  start: startGame,

  answer: submitAnswer,

  giveup(room, player) {
    requirePlaying(room);
    requireIdle(room);
    if (room.players[room.current].id !== player.id) throw new GameError("It's not your turn.", 409);
    eliminate(room, room.current, "gave up");
  },

  pause(room, player) {
    requireHost(room, player);
    requirePlaying(room);
    requireIdle(room);
    if (room.seconds === 0 || room.paused) return;
    haltTimer(room);
    room.paused = true;
    setEvent(room, "info", "The host paused the game.");
  },

  resume(room, player) {
    requireHost(room, player);
    requirePlaying(room);
    if (!room.paused) return;
    room.paused = false;
    setEvent(room, "info", "Back on!");
    runTimer(room);
  },

  lobby(room, player) {
    requireHost(room, player);
    if (room.phase === "playing") endGame(room);
    room.phase = "lobby";
    room.players = room.players.filter((p) => !p.left && p.connections > 0);
    if (!room.players.some((p) => p.id === room.hostId)) handOffHost(room);
    for (const p of room.players) p.out = false;
    room.answers = [];
    room.eliminated = [];
    setEvent(room, "info", "Back in the lobby.");
  },

  leave(room, player) {
    if (room.phase === "playing") {
      const idx = room.players.indexOf(player);
      if (!player.out) eliminate(room, idx, "left the game");
      player.left = true;
      disconnectClientsOf(room, player.id);
      if (room.hostId === player.id) handOffHost(room);
      if (room.players.every((p) => p.left)) deleteRoom(room);
    } else {
      setEvent(room, "info", `${player.name} left.`);
      disconnectClientsOf(room, player.id);
      removePlayer(room, player);
    }
  },
};

async function act(room, player, body) {
  const fn = actions[body && body.type];
  if (!fn) throw new GameError("Unknown action.");
  try {
    await fn(room, player, body);
  } finally {
    if (rooms.has(room.code)) broadcast(room);
  }
}

module.exports = {
  GameError,
  createRoom,
  joinRoom,
  getRoom,
  auth,
  attachClient,
  act,
  rooms,
  lanOrigin: null,
};
