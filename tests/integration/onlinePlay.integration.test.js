"use strict";

/**
 * "Login -> Play Online" flow against MongoDB:
 * one-call play, auto-start after matchmaking, resume (/api/games/active), surrender cleanup.
 *
 *   MONGO_URI_TEST="mongodb://localhost:27017/ludo_test" node --test tests/integration/onlinePlay.integration.test.js
 */

process.env.NODE_ENV = "test";
process.env.MONGO_URI = process.env.MONGO_URI_TEST || "";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const URI = process.env.MONGO_URI_TEST;
const enabled = Boolean(URI) && /test/i.test(URI);
const skip = enabled ? false : "set MONGO_URI_TEST (database name must contain 'test') to run";

let mongoose, app, server, base, socketManager;

const api = async (method, path, token, body) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const mkUser = async (tag) => {
  const email = `${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}@example.com`;
  const r = await api("POST", "/api/auth/register", null, { name: `User ${tag}`, email, password: "Passw0rd!123" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.data.token, id: r.body.data.user.id };
};

test.before(async () => {
  if (!enabled) return;
  mongoose = require("mongoose");
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  app = require("../../app");
  socketManager = require("../../src/sockets/socketManager");
  await require("../../src/modules/rewards/controllers/reward.controller").seedDefaultRewards();
  for (const m of Object.values(mongoose.models)) await m.init();
  server = http.createServer(app);
  socketManager.init(server);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (!enabled) return;
  await socketManager.close();
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("Play Online: queue -> auto-started match -> resume -> surrender -> idle", { skip }, async () => {
  const p1 = await mkUser("online1");
  const p2 = await mkUser("online2");

  // nothing running yet
  const idle = await api("GET", "/api/games/active", p1.token);
  assert.equal(idle.status, 200);
  assert.equal(idle.body.data.status, "idle");

  // player 1 searches
  const q1 = await api("POST", "/api/games/online/play", p1.token, { entryFee: 0, gameMode: "twoPlayer" });
  assert.equal(q1.status, 201, JSON.stringify(q1.body));
  assert.equal(q1.body.data.resumed, false);
  assert.equal(q1.body.data.status, "waiting");
  assert.equal((await api("GET", "/api/games/active", p1.token)).body.data.status, "in_queue");

  // pressing "Play" again resumes the search instead of failing with 400
  const again = await api("POST", "/api/games/online/play", p1.token, { entryFee: 0 });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.resumed, true);
  assert.equal(again.body.data.status, "in_queue");

  // player 2 searches -> matched AND already started
  const q2 = await api("POST", "/api/games/online/play", p2.token, { entryFee: 0, gameMode: "twoPlayer" });
  assert.equal(q2.status, 200, JSON.stringify(q2.body));
  assert.equal(q2.body.data.matched, true);
  assert.equal(q2.body.data.autoStarted, true);
  const sessionId = q2.body.data.sessionId;
  assert.ok(sessionId);
  assert.equal(q2.body.data.you.color, "Green");
  assert.equal(q2.body.data.state.me.isMyTurn, false);

  // player 1 (host, seat 0) learns about the session through the status endpoint
  const st1 = await api("GET", "/api/matchmaking/status", p1.token);
  assert.equal(st1.body.data.status, "matched");
  assert.equal(st1.body.data.sessionId, sessionId);

  // resume: player 1 may roll, player 2 may not
  const a1 = await api("GET", "/api/games/active", p1.token);
  assert.equal(a1.body.data.status, "in_game");
  assert.equal(a1.body.data.sessionId, sessionId);
  assert.equal(a1.body.data.me.color, "Red");
  assert.equal(a1.body.data.me.canRoll, true);
  const a2 = await api("GET", "/api/games/active", p2.token);
  assert.equal(a2.body.data.me.canRoll, false);

  // dice is decided by the server
  const roll = await api("POST", `/api/games/session/${sessionId}/roll-dice`, p1.token);
  assert.equal(roll.status, 200, JSON.stringify(roll.body));
  assert.ok(roll.body.data.diceValue >= 1 && roll.body.data.diceValue <= 6);

  // "Play" while a game is running resumes that game
  const resume = await api("POST", "/api/games/online/play", p2.token, { entryFee: 0 });
  assert.equal(resume.status, 200);
  assert.equal(resume.body.data.resumed, true);
  assert.equal(resume.body.data.status, "in_game");

  // surrender ends the match; both players are idle again
  const sur = await api("POST", `/api/games/session/${sessionId}/surrender`, p2.token);
  assert.equal(sur.status, 200, JSON.stringify(sur.body));
  assert.equal((await api("GET", "/api/games/active", p1.token)).body.data.status, "idle");
  assert.equal((await api("GET", "/api/games/active", p2.token)).body.data.status, "idle");
  assert.equal((await api("GET", "/api/matchmaking/status", p1.token)).body.data.status, "idle");
});

test("Play Online: cancel while searching", { skip }, async () => {
  const p = await mkUser("online_cancel");
  const q = await api("POST", "/api/games/online/play", p.token, { entryFee: 0 });
  assert.equal(q.status, 201);
  const del = await api("DELETE", "/api/games/online/play", p.token);
  assert.equal(del.status, 200);
  assert.equal((await api("GET", "/api/games/active", p.token)).body.data.status, "idle");
});
