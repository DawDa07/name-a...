"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

loadEnvFile(path.join(__dirname, ".env"));
const rooms = require("./lib/rooms");

// KEY=value lines; variables already set in the environment win.
function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 64 * 1024;
const INDEX_HTML = path.join(__dirname, "index.html");

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new rooms.GameError("Request body too large", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new rooms.GameError("Invalid JSON", 400));
      }
    });
    req.on("error", reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = await fs.promises.readFile(INDEX_HTML);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(html);
  }

  if (parts[0] !== "api" || parts[1] !== "rooms") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found");
  }

  // POST /api/rooms -> create a room
  if (parts.length === 2 && req.method === "POST") {
    const body = await readJson(req);
    const { room, player } = rooms.createRoom(body.name);
    return sendJson(res, 200, { code: room.code, playerId: player.id, token: player.token });
  }

  const code = parts[2];
  const sub = parts[3];

  // GET /api/rooms/:code/events?token= -> live state stream
  if (sub === "events" && req.method === "GET") {
    let room, player;
    try {
      room = rooms.getRoom(code);
      player = rooms.auth(room, url.searchParams.get("token") || "");
    } catch (err) {
      return rooms.sendGone(res, err.message);
    }
    return rooms.attachClient(room, player, res);
  }

  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  const body = await readJson(req);

  // POST /api/rooms/:code/join
  if (sub === "join") {
    const { room, player } = rooms.joinRoom(code, body.name);
    return sendJson(res, 200, { code: room.code, playerId: player.id, token: player.token });
  }

  // POST /api/rooms/:code/action
  if (sub === "action") {
    const room = rooms.getRoom(code);
    const player = rooms.auth(room, body.token);
    await rooms.act(room, player, body);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "Not found" });
}

function lanOrigin() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === "IPv4" && !a.internal) return `http://${a.address}:${PORT}`;
    }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (err) {
    const status = err instanceof rooms.GameError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? "Something went wrong on the server." : err.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  rooms.lanOrigin = lanOrigin();
  console.log(`Name the Game running at http://localhost:${PORT}`);
  if (rooms.lanOrigin) console.log(`Players on the same Wi-Fi can join at ${rooms.lanOrigin}`);
  if (!process.env.GEMINI_API_KEY && !process.env.NTG_FAKE_JUDGE) {
    console.log("No GEMINI_API_KEY set, so answers can't be checked. Get a free key at https://aistudio.google.com/apikey");
    console.log("and put GEMINI_API_KEY=your-key in a .env file next to server.js, then restart.");
  }
});
