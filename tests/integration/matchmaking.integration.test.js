"use strict";

/**
 * End-to-end integration tests for Auto-Matchmaking Queue APIs against MongoDB.
 *
 *   MONGO_URI_TEST="mongodb://localhost:27017/ludo_test" node --test tests/integration/matchmaking.integration.test.js
 */

process.env.NODE_ENV = "test";
process.env.MONGO_URI = process.env.MONGO_URI_TEST || "";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const URI = process.env.MONGO_URI_TEST;
const enabled = Boolean(URI) && /test/i.test(URI);
const skip = enabled ? false : "set MONGO_URI_TEST (database name must contain 'test') to run";

let mongoose, app, server, base, walletService, MatchmakingQueue, GameRoom;

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

const getCoins = async (u) => {
  const r = await api("GET", "/api/wallet/me", u.token);
  return r.body.data.balance;
};

test.before(async () => {
  if (!enabled) return;
  mongoose = require("mongoose");
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();

  app = require("../../app");
  walletService = require("../../src/modules/wallet/services/wallet.service");
  MatchmakingQueue = require("../../src/modules/matchmaking/models/MatchmakingQueue");
  GameRoom = require("../../src/modules/rooms/models/GameRoom");

  await require("../../src/modules/rewards/controllers/reward.controller").seedDefaultRewards();

  // Ensure unique and compound indexes exist
  for (const m of Object.values(mongoose.models)) {
    await m.init();
  }

  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (!enabled) return;
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("First player enters waiting queue, second player matches automatically", { skip }, async () => {
  const p1 = await mkUser("p1");
  const p2 = await mkUser("p2");

  // Player 1 joins matchmaking queue
  const q1 = await api("POST", "/api/matchmaking/queue", p1.token, {
    entryFee: 50,
    gameMode: "twoPlayer",
  });

  assert.equal(q1.status, 201);
  assert.equal(q1.body.success, true);
  assert.equal(q1.body.data.status, "waiting");
  assert.equal(q1.body.data.entryFee, 50);

  // Player 1 status endpoint returns "waiting"
  const s1 = await api("GET", "/api/matchmaking/status", p1.token);
  assert.equal(s1.status, 200);
  assert.equal(s1.body.data.status, "waiting");

  // Player 2 joins with same entryFee and gameMode -> should automatically match
  const q2 = await api("POST", "/api/matchmaking/queue", p2.token, {
    entryFee: 50,
    gameMode: "twoPlayer",
  });

  assert.equal(q2.status, 200);
  assert.equal(q2.body.success, true);
  assert.equal(q2.body.data.status, "matched");
  assert.ok(q2.body.data.roomId);
  assert.ok(q2.body.data.roomCode);

  // Both players now have matching room details
  const s1After = await api("GET", "/api/matchmaking/status", p1.token);
  assert.equal(s1After.body.data.status, "matched");
  assert.equal(s1After.body.data.roomCode, q2.body.data.roomCode);
  assert.equal(s1After.body.data.roomId, q2.body.data.roomId);

  // Verify created GameRoom in DB
  const room = await GameRoom.findOne({ roomCode: q2.body.data.roomCode });
  assert.ok(room);
  assert.equal(room.players.length, 2);
  assert.equal(room.entryFee, 50);
  assert.equal(room.prizePool, 100);
});

test("Duplicate queue requests for the same player are rejected", { skip }, async () => {
  const p = await mkUser("dup_test");

  const q1 = await api("POST", "/api/matchmaking/queue", p.token, {
    entryFee: 0,
    gameMode: "twoPlayer",
  });
  assert.equal(q1.status, 201);

  // Second immediate attempt
  const q2 = await api("POST", "/api/matchmaking/queue", p.token, {
    entryFee: 0,
    gameMode: "twoPlayer",
  });
  assert.equal(q2.status, 400);
  assert.equal(q2.body.success, false);
  assert.match(q2.body.message, /already in the matchmaking queue/i);
});

test("Player cannot be matched with themselves", { skip }, async () => {
  const p = await mkUser("self_match");

  await api("POST", "/api/matchmaking/queue", p.token, {
    entryFee: 20,
    gameMode: "twoPlayer",
  });

  // Query queue directly to verify no self-matching is possible
  const selfMatch = await MatchmakingQueue.findOne({
    user: p.id,
    "opponent.user": p.id,
  });
  assert.equal(selfMatch, null);
});

test("Queue cancellation refunds entry fee cleanly", { skip }, async () => {
  const p = await mkUser("cancel_test");
  const initialCoins = await getCoins(p);

  // Join queue with 100 coins
  const q = await api("POST", "/api/matchmaking/queue", p.token, {
    entryFee: 100,
    gameMode: "twoPlayer",
  });
  assert.equal(q.status, 201);

  const coinsAfterJoin = await getCoins(p);
  assert.equal(coinsAfterJoin, initialCoins - 100);

  // Cancel queue
  const del = await api("DELETE", "/api/matchmaking/queue", p.token);
  assert.equal(del.status, 200);
  assert.equal(del.body.data.status, "cancelled");
  assert.equal(del.body.data.refundedAmount, 100);

  const coinsAfterCancel = await getCoins(p);
  assert.equal(coinsAfterCancel, initialCoins);

  // Verify status is now idle / cancelled
  const st = await api("GET", "/api/matchmaking/status", p.token);
  assert.equal(st.body.data.status, "idle");
});

test("Players with different entry fees do not match each other", { skip }, async () => {
  const pLow = await mkUser("low_fee");
  const pHigh = await mkUser("high_fee");

  const q1 = await api("POST", "/api/matchmaking/queue", pLow.token, {
    entryFee: 10,
    gameMode: "twoPlayer",
  });
  assert.equal(q1.status, 201);
  assert.equal(q1.body.data.status, "waiting");

  const q2 = await api("POST", "/api/matchmaking/queue", pHigh.token, {
    entryFee: 100,
    gameMode: "twoPlayer",
  });
  assert.equal(q2.status, 201);
  assert.equal(q2.body.data.status, "waiting"); // Did not match because fees differ!

  // Clean up
  await api("DELETE", "/api/matchmaking/queue", pLow.token);
  await api("DELETE", "/api/matchmaking/queue", pHigh.token);
});

test("Existing private room create and join APIs remain completely functional", { skip }, async () => {
  const host = await mkUser("private_host");
  const guest = await mkUser("private_guest");

  const roomRes = await api("POST", "/api/rooms/create", host.token, {
    maxPlayers: 2,
    gameMode: "twoPlayer",
    entryFee: 50,
  });
  assert.equal(roomRes.status, 201);
  const roomCode = roomRes.body.data.room.roomCode;
  assert.ok(roomCode);

  const joinRes = await api("POST", "/api/rooms/join", guest.token, { roomCode });
  assert.equal(joinRes.status, 200);
  assert.equal(joinRes.body.data.room.players.length, 2);
});
