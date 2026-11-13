"use strict";

/**
 * Integration tests for 3-Player Ludo mode (rooms, gameplay, surrender, settlement, admin APIs).
 *
 *   $env:MONGO_URI_TEST="mongodb://localhost:27017/ludo_test"; node --test tests/integration/threePlayer.integration.test.js
 */

process.env.NODE_ENV = "test";
process.env.MONGO_URI = process.env.MONGO_URI_TEST || "";
process.env.RATE_LIMIT_ENABLED = "false";
process.env.REQUIRE_REPLICA_SET = "false";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const URI = process.env.MONGO_URI_TEST;
const enabled = Boolean(URI) && /test/i.test(URI);
const skip = enabled ? false : "set MONGO_URI_TEST (database name must contain 'test') to run";

let mongoose, app, server, base;
let GameSession, Admin, adminTok;

const api = async (method, path, token, body) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
  return { token: r.body.data.token, id: r.body.data.user.id, email };
};

const coins = async (u) => (await api("GET", "/api/wallet/me", u.token)).body.data.balance;

test.before(async () => {
  if (!enabled) return;

  mongoose = require("mongoose");
  await mongoose.connect(URI);

  const dbName = mongoose.connection.name;
  if (!dbName || !/test/i.test(dbName)) {
    await mongoose.disconnect();
    throw new Error(`Refusing to run tests: connected database '${dbName}' does not contain 'test'`);
  }

  await mongoose.connection.dropDatabase();

  const config = require("../../config/env");
  config.rateLimit.enabled = false;

  app = require("../../app");
  GameSession = require("../../src/modules/games/models/GameSession");
  Admin = require("../../src/modules/admin/models/admin.model");

  for (const m of Object.values(mongoose.models)) {
    await m.init();
  }

  await new Admin({
    name: "ThreePlayer Admin",
    email: "admin_3p@test.io",
    password: "k7-Vault-Orange-42",
    role: "admin",
  }).save();

  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;

  const loginRes = await api("POST", "/api/admin/login", null, {
    email: "admin_3p@test.io",
    password: "k7-Vault-Orange-42",
  });
  assert.equal(loginRes.status, 200);
  adminTok = loginRes.body.data.token;
});

test.after(async () => {
  if (!enabled) return;
  if (server) server.close();
  if (mongoose && mongoose.connection.readyState !== 0) {
    const dbName = mongoose.connection.name;
    if (dbName && /test/i.test(dbName)) {
      await mongoose.connection.dropDatabase();
    }
    await mongoose.disconnect();
  }
});

test("3-player room: create via maxPlayers or gameMode, reject mismatch, assign Red/Green/Yellow, reject 4th player", { skip }, async () => {
  const [p1, p2, p3, p4] = await Promise.all([mkUser("3p_a"), mkUser("3p_b"), mkUser("3p_c"), mkUser("3p_d")]);

  // Mismatched maxPlayers + gameMode rejected
  const mismatch = await api("POST", "/api/rooms/create", p1.token, {
    maxPlayers: 3,
    gameMode: "twoPlayer",
    entryFee: 100,
  });
  assert.equal(mismatch.status, 400);

  // Create using gameMode: "threePlayer" only (maxPlayers inferred as 3)
  const byMode = await api("POST", "/api/rooms/create", p1.token, {
    gameMode: "threePlayer",
    entryFee: 50,
  });
  assert.equal(byMode.status, 201, JSON.stringify(byMode.body));
  assert.equal(byMode.body.data.room.maxPlayers, 3);
  assert.equal(byMode.body.data.room.gameMode, "threePlayer");
  assert.equal(await coins(p1), 950);

  // Leave/cancel refunds host
  assert.equal((await api("POST", "/api/rooms/leave", p1.token, { roomCode: byMode.body.data.room.roomCode })).status, 200);
  assert.equal(await coins(p1), 1000);

  // Create using maxPlayers: 3 (gameMode inferred as "threePlayer")
  const created = await api("POST", "/api/rooms/create", p1.token, { maxPlayers: 3, entryFee: 100 });
  assert.equal(created.status, 201);
  const room = created.body.data.room;
  assert.equal(room.maxPlayers, 3);
  assert.equal(room.gameMode, "threePlayer");
  assert.equal(room.players[0].seatIndex, 0);
  assert.equal(room.players[0].color, "Red");
  assert.equal(await coins(p1), 900);

  // Player 2 joins -> Green (seat 1)
  const j2 = await api("POST", "/api/rooms/join", p2.token, { roomCode: room.roomCode });
  assert.equal(j2.status, 200);
  assert.equal(j2.body.data.seatIndex, 1);
  assert.equal(j2.body.data.assignedColor, "Green");
  assert.equal(j2.body.data.room.status, "waiting");
  assert.equal(await coins(p2), 900);

  // Player 3 joins -> Yellow (seat 2), room becomes "starting"
  const j3 = await api("POST", "/api/rooms/join", p3.token, { roomCode: room.roomCode });
  assert.equal(j3.status, 200);
  assert.equal(j3.body.data.seatIndex, 2);
  assert.equal(j3.body.data.assignedColor, "Yellow");
  assert.equal(j3.body.data.room.status, "starting");
  assert.equal(await coins(p3), 900);

  // 4th player rejected without losing coins
  const j4 = await api("POST", "/api/rooms/join", p4.token, { roomCode: room.roomCode });
  assert.equal(j4.status, 400);
  assert.equal(await coins(p4), 1000);
});

test("3-player game: turn rotation across 3 seats, 1 surrender continues match, 2nd surrender settles to survivor", { skip }, async () => {
  const [p1, p2, p3] = await Promise.all([mkUser("3g_a"), mkUser("3g_b"), mkUser("3g_c")]);

  const code = (await api("POST", "/api/rooms/create", p1.token, { maxPlayers: 3, entryFee: 100 })).body.data.room.roomCode;
  await api("POST", "/api/rooms/join", p2.token, { roomCode: code });
  await api("POST", "/api/rooms/join", p3.token, { roomCode: code });

  const started = await api("POST", "/api/games/start", p1.token, { roomCode: code });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const session = started.body.data.session;
  const sid = session._id;
  assert.equal(session.gameMode, "threePlayer");
  assert.equal(session.prizePool, 300);
  assert.equal(session.players.length, 3);
  assert.deepEqual(
    session.players.map((p) => [p.seatIndex, p.color]),
    [
      [0, "Red"],
      [1, "Green"],
      [2, "Yellow"],
    ]
  );

  // Verify turn order: p1 (seat 0) rolls & moves -> verify next turn (either p1 extra turn or p2 seat 1)
  assert.equal((await api("POST", `/api/games/session/${sid}/roll-dice`, p2.token)).status, 403);
  assert.equal((await api("POST", `/api/games/session/${sid}/roll-dice`, p3.token)).status, 403);

  // Play turns for p1 until turn passes to p2 (seat 1)
  let currentId = p1.id;
  for (let guard = 0; guard < 10 && currentId === p1.id; guard++) {
    const roll = await api("POST", `/api/games/session/${sid}/roll-dice`, p1.token);
    assert.equal(roll.status, 200);
    if (roll.body.data.turnPassed) {
      currentId = String(roll.body.data.currentTurnPlayer);
      break;
    }
    const mv = await api("POST", `/api/games/session/${sid}/move-token`, p1.token, {
      tokenId: roll.body.data.movableTokenIds[0],
    });
    assert.equal(mv.status, 200);
    currentId = String(mv.body.data.session.currentTurnPlayer);
  }
  assert.equal(currentId, p2.id, "After p1 finishes turn, p2 (seat 1) must be active");

  // p2 surrenders: match MUST continue because 2 players remain (p1 & p3)
  const surr2 = await api("POST", `/api/games/session/${sid}/surrender`, p2.token);
  assert.equal(surr2.status, 200);
  assert.equal(surr2.body.message, "You have surrendered the match");
  assert.equal(surr2.body.data.gameCompleted, undefined);
  assert.equal(surr2.body.data.session.status, "in_progress");
  assert.equal(String(surr2.body.data.session.currentTurnPlayer), p3.id, "Turn must advance from surrendered p2 to p3");

  // p1 surrenders: only p3 remains -> match completes and p3 wins entire 300 coin pool
  const surr1 = await api("POST", `/api/games/session/${sid}/surrender`, p1.token);
  assert.equal(surr1.status, 200);
  assert.equal(surr1.body.data.gameCompleted, true);
  assert.equal(surr1.body.data.session.status, "completed");
  assert.equal(String(surr1.body.data.session.winner), p3.id);

  assert.equal(await coins(p1), 900);
  assert.equal(await coins(p2), 900);
  assert.equal(await coins(p3), 900 + 300);

  // Admin games filter and dashboard reflect threePlayer mode accurately
  const adminGames = await api("GET", "/api/admin/games?mode=threePlayer", adminTok);
  assert.equal(adminGames.status, 200);
  assert.ok(adminGames.body.data.games.some((g) => g.roomCode === code && g.mode === "threePlayer"));

  const dash = await api("GET", "/api/admin/dashboard?refresh=1", adminTok);
  assert.equal(dash.status, 200);
  const modeEntry = dash.body.data.modes.find((m) => m.name === "threePlayer");
  assert.ok(modeEntry, "Dashboard modes must include threePlayer");
  assert.equal(modeEntry.label, "3 Player");
  assert.ok(modeEntry.count >= 1);

  const topGame = dash.body.data.topGames.find((g) => g.roomId === code);
  assert.ok(topGame, "topGames should include the 3-player game");
  assert.equal(topGame.maxPlayers, 3);
  assert.equal(topGame.playersLabel, "3/3");
  assert.equal(topGame.modeLabel, "3 Player");
});

test("3-player room started early with 2 players collects and awards 2x entryFee only", { skip }, async () => {
  const [p1, p2] = await Promise.all([mkUser("3e_a"), mkUser("3e_b")]);
  const code = (await api("POST", "/api/rooms/create", p1.token, { maxPlayers: 3, entryFee: 100 })).body.data.room.roomCode;
  await api("POST", "/api/rooms/join", p2.token, { roomCode: code });

  // Host starts before 3rd player joins
  const started = await api("POST", "/api/games/start", p1.token, { roomCode: code });
  assert.equal(started.status, 201);
  assert.equal(started.body.data.session.gameMode, "threePlayer");
  assert.equal(started.body.data.session.prizePool, 200, "Prize pool must equal actual collected fees (2 * 100)");
  assert.equal(started.body.data.session.players.length, 2);

  // Fast-forward and complete via score
  const sid = started.body.data.session._id;
  await GameSession.updateOne(
    { _id: sid },
    { $set: { startedAt: new Date(Date.now() - 11 * 60_000), "players.0.score": 50, "players.1.score": 10 } }
  );
  const done = await api("POST", `/api/games/session/${sid}/complete`, p2.token);
  assert.equal(done.status, 200);
  assert.equal(await coins(p1), 900 + 200);
  assert.equal(await coins(p2), 900);
});
