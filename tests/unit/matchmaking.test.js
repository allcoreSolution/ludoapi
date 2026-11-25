"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const MatchmakingQueue = require("../../src/modules/matchmaking/models/MatchmakingQueue");
const {
  joinQueueValidation,
  validateRequest,
} = require("../../src/modules/matchmaking/validations/matchmaking.validation");
const socketManager = require("../../src/sockets/socketManager");
const rateLimit = require("../../middleware/rateLimit.middleware");

const runValidation = async (body) => {
  const req = { body, params: {}, query: {} };
  for (const mw of joinQueueValidation) {
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

test("MatchmakingQueue schema has canonical statuses, fields, and default values", () => {
  const statusPath = MatchmakingQueue.schema.path("status");
  assert.ok(statusPath, "status field should exist on schema");
  assert.deepEqual(statusPath.enumValues, ["waiting", "searching", "matched", "cancelled", "expired"]);

  const gameModePath = MatchmakingQueue.schema.path("gameMode");
  assert.ok(gameModePath, "gameMode field should exist on schema");
  assert.deepEqual(gameModePath.enumValues, ["twoPlayer", "threePlayer", "fourPlayer"]);

  const maxPlayersPath = MatchmakingQueue.schema.path("maxPlayers");
  assert.ok(maxPlayersPath, "maxPlayers field should exist on schema");
  assert.deepEqual(maxPlayersPath.enumValues, [2, 3, 4]);

  const entryFeePath = MatchmakingQueue.schema.path("entryFee");
  assert.ok(entryFeePath, "entryFee field should exist on schema");
  assert.equal(entryFeePath.defaultValue, 0);
});

test("joinQueueValidation accepts valid entryFee and gameMode combinations", async () => {
  const validBodies = [
    {},
    { entryFee: 0 },
    { entryFee: 50 },
    { entryFee: 1000 },
    { gameMode: "twoPlayer" },
    { gameMode: "threePlayer" },
    { gameMode: "fourPlayer" },
    { entryFee: 100, gameMode: "twoPlayer" },
  ];

  for (const body of validBodies) {
    const r = await runValidation(body);
    assert.equal(r.passed, true, `Expected ${JSON.stringify(body)} to pass validation`);
  }
});

test("joinQueueValidation rejects invalid entryFee and gameMode values", async () => {
  const invalidBodies = [
    { entryFee: -10 },
    { entryFee: "free" },
    { entryFee: 999999999 }, // exceeds maxEntryFee
    { gameMode: "singlePlayer" },
    { gameMode: "invalidMode" },
  ];

  for (const body of invalidBodies) {
    const r = await runValidation(body);
    assert.equal(r.passed, false, `Expected ${JSON.stringify(body)} to fail validation`);
    assert.equal(r.status, 400);
    assert.equal(r.payload.success, false);
    assert.ok(Array.isArray(r.payload.errors));
    assert.ok(r.payload.errors.length > 0);
  }
});

test("SocketManager exports init, getIO, emitToUser, and close functions", () => {
  assert.equal(typeof socketManager.init, "function");
  assert.equal(typeof socketManager.getIO, "function");
  assert.equal(typeof socketManager.emitToUser, "function");
  assert.equal(typeof socketManager.close, "function");

  // Before init, getIO should return null and emitToUser should safely return false without throwing
  assert.equal(socketManager.getIO(), null);
  assert.equal(socketManager.emitToUser("mock-user-id", "mock_event", {}), false);
});

test("rateLimit middleware exports matchmakingLimiter", () => {
  assert.ok(rateLimit.matchmakingLimiter, "matchmakingLimiter should be defined");
  assert.equal(typeof rateLimit.matchmakingLimiter, "function");
});
