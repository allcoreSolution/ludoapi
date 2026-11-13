"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const engine = require("../../src/modules/games/engine/ludoEngine");
const GameRoom = require("../../src/modules/rooms/models/GameRoom");
const GameSession = require("../../src/modules/games/models/GameSession");
const { resolveRoomMode } = require("../../src/modules/rooms/services/room.service");
const { createRoomValidation, validateRequest } = require("../../src/modules/rooms/validations/room.validation");

const runValidation = async (body) => {
  const req = { body, params: {}, query: {} };
  for (const mw of createRoomValidation) {
    await mw.run(req);
  }
  let status = 200;
  let payload = null;
  let passed = false;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(obj) {
      payload = obj;
      return this;
    },
  };
  validateRequest(req, res, () => {
    passed = true;
  });
  return { passed, status, payload };
};

test("ludoEngine exports canonical 2, 3, and 4 player mode metadata", () => {
  assert.deepEqual(engine.MODE_NAMES, ["twoPlayer", "threePlayer", "fourPlayer"]);
  assert.deepEqual(engine.MAX_PLAYERS_LIST, [2, 3, 4]);
  assert.equal(engine.MODE_BY_PLAYERS[3], "threePlayer");
  assert.equal(engine.PLAYERS_BY_MODE.threePlayer, 3);
  assert.equal(engine.MODE_LABEL.threePlayer, "3 Player");
});

test("GameRoom and GameSession schemas accept 3-player mode", () => {
  assert.deepEqual(GameRoom.schema.path("maxPlayers").enumValues, [2, 3, 4]);
  assert.deepEqual(GameRoom.schema.path("gameMode").enumValues, ["twoPlayer", "threePlayer", "fourPlayer"]);
  assert.deepEqual(GameSession.schema.path("gameMode").enumValues, ["twoPlayer", "threePlayer", "fourPlayer"]);
});

test("createRoomValidation accepts 2, 3, and 4 players and rejects invalid values", async () => {
  for (const body of [
    { maxPlayers: 2 },
    { maxPlayers: 3 },
    { maxPlayers: 4 },
    { gameMode: "threePlayer" },
    { maxPlayers: 3, gameMode: "threePlayer", entryFee: 50 },
  ]) {
    const r = await runValidation(body);
    assert.equal(r.passed, true, `Expected valid body ${JSON.stringify(body)} to pass`);
  }

  for (const bad of [{ maxPlayers: 1 }, { maxPlayers: 5 }, { gameMode: "fivePlayer" }]) {
    const r = await runValidation(bad);
    assert.equal(r.passed, false, `Expected invalid body ${JSON.stringify(bad)} to fail`);
    assert.equal(r.status, 400);
  }
});

test("resolveRoomMode resolves maxPlayers and gameMode uniformly and rejects mismatches", () => {
  assert.deepEqual(resolveRoomMode({}), { maxPlayers: 2, gameMode: "twoPlayer" });
  assert.deepEqual(resolveRoomMode({ maxPlayers: 3 }), { maxPlayers: 3, gameMode: "threePlayer" });
  assert.deepEqual(resolveRoomMode({ gameMode: "threePlayer" }), { maxPlayers: 3, gameMode: "threePlayer" });
  assert.deepEqual(resolveRoomMode({ maxPlayers: 3, gameMode: "threePlayer" }), { maxPlayers: 3, gameMode: "threePlayer" });
  assert.deepEqual(resolveRoomMode({ maxPlayers: 4 }), { maxPlayers: 4, gameMode: "fourPlayer" });
  assert.deepEqual(resolveRoomMode({ gameMode: "fourPlayer" }), { maxPlayers: 4, gameMode: "fourPlayer" });

  assert.throws(() => resolveRoomMode({ maxPlayers: 3, gameMode: "twoPlayer" }), /does not match/);
  assert.throws(() => resolveRoomMode({ maxPlayers: 5 }), /must be 2, 3, or 4/);
  assert.throws(() => resolveRoomMode({ gameMode: "sixPlayer" }), /must be 'twoPlayer', 'threePlayer', or 'fourPlayer'/);
});

test("ludoEngine 3-player turn rotation, capture, and settlement", () => {
  const mkPlayer = (user, seatIndex, score = 0) => ({
    user,
    seatIndex,
    color: ["Red", "Green", "Yellow", "Blue"][seatIndex],
    score,
    hasSurrendered: false,
    tokens: [0, 1, 2, 3].map((tokenId) => ({ tokenId, step: 0, isHome: false })),
  });

  const players = [mkPlayer("p0", 0), mkPlayer("p1", 1), mkPlayer("p2", 2)];

  // Seat rotation 0 -> 1 -> 2 -> 0
  assert.equal(engine.getNextActivePlayer(players, 0).user, "p1");
  assert.equal(engine.getNextActivePlayer(players, 1).user, "p2");
  assert.equal(engine.getNextActivePlayer(players, 2).user, "p0");

  // Seat 2 (Yellow, offset 26) capturing Seat 0 (Red, offset 0) at global tile 29 (non-safe):
  // Seat 0 step 29 -> global 29; Seat 2 step 3 -> global 29
  players[0].tokens[0].step = 29;
  players[0].score = 29;
  const move = engine.applyMove({ players, userId: "p2", tokenId: 0, diceValue: 3 });
  assert.ok(move.captured);
  assert.equal(move.captured.opponentUser, "p0");
  assert.equal(players[0].tokens[0].step, 0);
  assert.equal(players[0].score, 0);

  // Surrender skips Seat 1 -> rotation becomes 0 -> 2 -> 0
  players[1].hasSurrendered = true;
  assert.equal(engine.getNextActivePlayer(players, 0).user, "p2");
  assert.equal(engine.getNextActivePlayer(players, 2).user, "p0");

  // Settlement with 3 players: 2-way tie splits prize pool, 3rd gets 0
  players[0].score = 50;
  players[2].score = 50;
  const draw = engine.computeSettlement({ players, prizePool: 300 });
  assert.equal(draw.isDraw, true);
  assert.equal(draw.winnerId, null);
  assert.deepEqual(
    draw.ranking.map((r) => [r.userId, r.rank, r.outcome, r.prize]),
    [
      ["p0", 1, "draw", 150],
      ["p2", 1, "draw", 150],
      ["p1", 3, "loss", 0],
    ]
  );
});

