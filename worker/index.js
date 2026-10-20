// Cloudflare Worker version of server.js, for when the page is hosted on GitHub Pages.
// All rooms live in memory in one Durable Object, so every request is routed to it.
import { DurableObject } from "cloudflare:workers";
import rooms from "../lib/rooms.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const MAX_BODY_BYTES = 64 * 1024;

export default {
  fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!new URL(request.url).pathname.startsWith("/api/")) {
      return new Response("Name the Game server. Open the game's GitHub Pages site to play.", { headers: CORS });
    }
    return env.GAME.get(env.GAME.idFromName("all-rooms")).fetch(request);
  },
};

export class Game extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    for (const k of ["GEMINI_API_KEY", "GEMINI_MODEL", "NTG_FAKE_JUDGE"]) if (env[k]) process.env[k] = env[k];
  }

  async fetch(request) {
    try {
      return await handle(request);
    } catch (err) {
      const status = err instanceof rooms.GameError ? err.status : 500;
      if (status === 500) console.error(err);
      return json(status, { error: status === 500 ? "Something went wrong on the server." : err.message });
    }
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new rooms.GameError("Request body too large", 413);
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new rooms.GameError("Invalid JSON", 400);
  }
}

// Live updates go over a WebSocket here: Cloudflare doesn't report when a streamed response's
// client goes away, but it does report closed sockets, which is how disconnected players are spotted.
function webSocket(use) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  const closeListeners = [];
  const conn = {
    ended: false,
    send(data) {
      if (conn.ended) return;
      try {
        server.send(data);
      } catch {
        finish();
      }
    },
    ping() {
      conn.send("ping");
    },
    end() {
      if (conn.ended) return;
      try {
        server.close(1000, "bye");
      } catch {}
      finish();
    },
    onClose(fn) {
      closeListeners.push(fn);
    },
  };
  function finish() {
    if (conn.ended) return;
    conn.ended = true;
    for (const fn of closeListeners) fn();
  }
  server.addEventListener("close", finish);
  server.addEventListener("error", finish);
  use(conn);
  return new Response(null, { status: 101, webSocket: client });
}

async function handle(request) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[1] !== "rooms") return json(404, { error: "Not found" });

  if (parts.length === 2 && request.method === "POST") {
    const body = await readJson(request);
    const { room, player } = rooms.createRoom(body.name);
    return json(200, { code: room.code, playerId: player.id, token: player.token });
  }

  const code = parts[2];
  const sub = parts[3];

  if (sub === "events" && request.method === "GET") {
    if (request.headers.get("Upgrade") !== "websocket") return json(426, { error: "Expected a WebSocket" });
    let room, player;
    try {
      room = rooms.getRoom(code);
      player = rooms.auth(room, url.searchParams.get("token") || "");
    } catch (err) {
      return webSocket((conn) => {
        conn.send(JSON.stringify({ gone: err.message }));
        conn.end();
      });
    }
    return webSocket((conn) => rooms.attachClient(room, player, conn));
  }

  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  const body = await readJson(request);

  if (sub === "join") {
    const { room, player } = rooms.joinRoom(code, body.name);
    return json(200, { code: room.code, playerId: player.id, token: player.token });
  }

  if (sub === "action") {
    const room = rooms.getRoom(code);
    const player = rooms.auth(room, body.token);
    await rooms.act(room, player, body);
    return json(200, { ok: true });
  }

  return json(404, { error: "Not found" });
}
