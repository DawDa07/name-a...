"use strict";

// Starts the real server and plays a full 3-player game over HTTP + SSE, with the offline test judge.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

// TEST_BASE runs against an already running server instead, e.g. the Cloudflare worker under `wrangler dev`.
const PORT = 3999;
const BASE = process.env.TEST_BASE || `http://localhost:${PORT}`;
let server;

before(async () => {
  if (process.env.TEST_BASE) return;
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), NTG_FAKE_JUDGE: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => server.stdout.once("data", resolve));
});

after(() => server?.kill());

async function post(p, body) {
  const res = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

// Keeps the latest state pushed to one player.
function watch(code, token) {
  return process.env.TEST_BASE ? watchSocket(code, token) : watchEvents(code, token);
}

function watchSocket(code, token) {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/rooms/${code}/events?token=${encodeURIComponent(token)}`);
  const w = { state: null, gone: null, close: () => ws.close() };
  ws.onmessage = (e) => {
    if (e.data === "ping") return;
    const msg = JSON.parse(e.data);
    if ("gone" in msg) w.gone = msg.gone;
    else w.state = msg;
  };
  return w;
}

function watchEvents(code, token) {
  const ctrl = new AbortController();
  const w = { state: null, gone: null, close: () => ctrl.abort() };
  (async () => {
    const res = await fetch(`${BASE}/api/rooms/${code}/events?token=${encodeURIComponent(token)}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = chunk.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("");
        if (!data) continue;
        if (chunk.includes("event: gone")) w.gone = JSON.parse(data).error;
        else w.state = JSON.parse(data);
      }
    }
  })().catch(() => {});
  return w;
}

async function until(fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting for condition");
}

test("full multiplayer game", async () => {
  const ann = (await post("/api/rooms", { name: "Ann" })).body;
  assert.match(ann.code, /^[A-HJ-NP-Z]{4}$/);
  const code = ann.code;
  const A = watch(code, ann.token);

  assert.equal((await post(`/api/rooms/ZZZZ/join`, { name: "Bob" })).status, 404);
  const bob = (await post(`/api/rooms/${code.toLowerCase()}/join`, { name: "Bob" })).body;
  const B = watch(code, bob.token);
  assert.equal((await post(`/api/rooms/${code}/join`, { name: "bob" })).status, 409);
  const cat = (await post(`/api/rooms/${code}/join`, { name: "Cat" })).body;
  const C = watch(code, cat.token);

  await until(() => A.state && A.state.players.length === 3 && A.state.players.every((p) => p.connected));
  assert.equal(B.state.hostId, ann.playerId);

  const act = (who, type, extra) => post(`/api/rooms/${code}/action`, { token: who.token, type, ...extra });

  assert.equal((await act(bob, "start", { topic: "Cheeses", seconds: 30 })).status, 403);
  assert.equal((await act(ann, "start", { topic: "Dogs", seconds: 30 })).status, 422, "rejected topic");
  assert.equal(C.state.phase, "lobby");
  assert.equal((await act(ann, "start", { topic: "Cheeses", seconds: 30 })).status, 200);
  await until(() => C.state.phase === "playing");
  assert.equal(C.state.currentId, ann.playerId);

  assert.equal((await act(bob, "answer", { answer: "Gouda" })).status, 409, "out of turn");

  await act(ann, "answer", { answer: "Brie" });
  await until(() => B.state.answers.length === 1);
  assert.equal(B.state.answers[0].title, "Brie");
  assert.equal(B.state.currentId, bob.playerId);

  await act(bob, "answer", { answer: "brie" });
  await until(() => A.state.event && /already said/.test(A.state.event.text));
  assert.equal(A.state.currentId, bob.playerId);

  await act(bob, "answer", { answer: "Italy" });
  await until(() => A.state.event && /Italy/.test(A.state.event.text) && /✗/.test(A.state.event.text));
  assert.equal(A.state.currentId, bob.playerId, "rejected answer keeps the turn");
  for (const removed of ["override", "rejectLast", "skip"]) {
    assert.equal((await act(ann, removed)).status, 400, `${removed} should no longer exist`);
  }
  await act(bob, "answer", { answer: "Gouda" });
  await until(() => C.state.answers.length === 2);
  assert.equal(C.state.currentId, cat.playerId);

  await act(cat, "giveup");
  await until(() => A.state.players.find((p) => p.name === "Cat").out);
  assert.equal(A.state.currentId, ann.playerId);

  await act(ann, "giveup");
  await until(() => A.state.phase === "over");
  assert.equal(A.state.winner, "Bob");
  assert.deepEqual(A.state.answers.map((a) => a.title), ["Brie", "Gouda"]);

  await act(ann, "start", {});
  await until(() => B.state.phase === "playing" && B.state.answers.length === 0);
  assert.ok(B.state.players.every((p) => !p.out));

  await act(ann, "lobby");
  await until(() => B.state.phase === "lobby");
  await act(ann, "start", { topic: "Cheeses", seconds: 1 });
  await until(() => A.state.phase === "playing");
  await until(() => A.state.eliminated.length === 1, 4000);
  assert.equal(A.state.eliminated[0].name, "Ann");
  assert.match(A.state.eliminated[0].reason, /time/);

  await act(ann, "lobby");
  await until(() => B.state.phase === "lobby");
  await act(ann, "start", { topic: "Cheeses", seconds: 0 });
  await until(() => A.state.phase === "playing");
  C.close();
  await until(() => A.state.players.find((p) => p.name === "Cat").out, 20000);
  assert.match(A.state.eliminated.at(-1).reason, /disconnected/);

  await act(ann, "lobby");
  await until(() => B.state.phase === "lobby");
  assert.equal(B.state.players.length, 2, "disconnected player is dropped from the lobby");
  await act(ann, "leave");
  await until(() => B.state.hostId === bob.playerId);
  await until(() => B.state.players.length === 1);

  A.close(); B.close();
});
