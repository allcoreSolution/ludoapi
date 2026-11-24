"use strict";

/**
 * Two-Player Online Multiplayer Integration Tests against MongoDB.
 *
 *   MONGO_URI_TEST="mongodb://localhost:27017/ludo_test" node --test tests/integration/onlineMatch.integration.test.js
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
  const r = await api("POST", "/api/auth/register", null, {
    name: `User ${tag}`,
    email,
    password: "Passw0rd!123",
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { token: r.body.data.token, id: r.body.data.user.id, email, name: `User ${tag}` };
};

test.before(async () => {
  if (!enabled) return;
  mongoose = require("mongoose");
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();

  app = require("../../app");
  socketManager = require("../../src/sockets/socketManager");
  await require("../../src/modules/rewards/controllers/reward.controller").seedDefaultRewards();

  for (const m of Object.values(mongoose.models)) {
    await m.init();
  }

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

test("Full Two-Player Online Match Flow: create, join, get game state, reconnect", { skip }, async () => {
  const host = await mkUser("host");
  const guest = await mkUser("guest");

  // 1. Create Match (POST /api/games/create)
  const createRes = await api("POST", "/api/games/create", host.token, {
    entryFee: 50,
    gameMode: "twoPlayer",
  });

  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.success, true);
  const roomCode = createRes.body.data.roomCode;
  const gameId = createRes.body.data.gameId;
  assert.ok(roomCode);
  assert.ok(gameId);
  assert.equal(createRes.body.data.players[0].color, "Red");
  assert.equal(createRes.body.data.players[0].seatIndex, 0);

  // 2. Guest Joins Match (POST /api/games/join) -> Auto-starts session
  const joinRes = await api("POST", "/api/games/join", guest.token, { roomCode });
  assert.equal(joinRes.status, 200);
  assert.equal(joinRes.body.success, true);
  assert.equal(joinRes.body.data.status, "in_progress");
  assert.ok(joinRes.body.data.sessionId);

  // Verify guest received Green slot
  const guestSlot = joinRes.body.data.players.find((p) => String(p.user) === guest.id);
  assert.ok(guestSlot);
  assert.equal(guestSlot.color, "Green");
  assert.equal(guestSlot.seatIndex, 1);

  // 3. Get Authoritative Game State (GET /api/games/:gameId)
  const stateRes = await api("GET", `/api/games/${roomCode}`, host.token);
  assert.equal(stateRes.status, 200);
  assert.equal(stateRes.body.success, true);
  assert.equal(stateRes.body.data.roomCode, roomCode);
  assert.equal(stateRes.body.data.players.length, 2);
  assert.equal(stateRes.body.data.status, "in_progress");
  assert.equal(stateRes.body.data.diceStatus, "waiting");
  assert.ok(stateRes.body.data.tokens[host.id]);
  assert.equal(stateRes.body.data.tokens[host.id].length, 4);

  // 4. Reconnect Match (POST /api/games/:gameId/reconnect)
  const reconnectRes = await api("POST", `/api/games/${joinRes.body.data.sessionId}/reconnect`, guest.token);
  assert.equal(reconnectRes.status, 200);
  assert.equal(reconnectRes.body.success, true);
  assert.equal(reconnectRes.body.data.status, "in_progress");
});

test("Out-of-turn dice roll is rejected by the server", { skip }, async () => {
  const host = await mkUser("turn_host");
  const guest = await mkUser("turn_guest");

  const createRes = await api("POST", "/api/games/create", host.token, { entryFee: 0 });
  const roomCode = createRes.body.data.roomCode;
  const joinRes = await api("POST", "/api/games/join", guest.token, { roomCode });
  const sessionId = joinRes.body.data.sessionId;

  // Red (Host) has seat 0 and starts the turn.
  // Guest tries to roll out-of-turn -> must be rejected (403)
  const guestRoll = await api("POST", `/api/games/session/${sessionId}/roll-dice`, guest.token);
  assert.equal(guestRoll.status, 403);
  assert.match(guestRoll.body.message, /not your turn/i);

  // Host rolls dice -> succeeds (200)
  const hostRoll = await api("POST", `/api/games/session/${sessionId}/roll-dice`, host.token);
  assert.equal(hostRoll.status, 200);
  assert.ok(hostRoll.body.data.diceValue >= 1 && hostRoll.body.data.diceValue <= 6);
});
