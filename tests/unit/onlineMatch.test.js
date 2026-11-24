"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createMatchValidation,
  joinMatchValidation,
  gameIdParamValidation,
  validateRequest,
} = require("../../src/modules/games/validations/game.validation");
const socketManager = require("../../src/sockets/socketManager");

const runValidation = async (middlewares, body = {}, params = {}) => {
  const req = { body, params, query: {} };
  for (const mw of middlewares) {
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

test("createMatchValidation accepts valid match options and rejects invalid values", async () => {
  const valid = [{}, { entryFee: 0 }, { entryFee: 100 }, { gameMode: "twoPlayer" }, { entryFee: 50, gameMode: "twoPlayer" }];
  for (const b of valid) {
    const r = await runValidation(createMatchValidation, b);
    assert.equal(r.passed, true, `Expected ${JSON.stringify(b)} to pass`);
  }

  const invalid = [{ entryFee: -10 }, { entryFee: "free" }, { gameMode: "sixPlayer" }];
  for (const b of invalid) {
    const r = await runValidation(createMatchValidation, b);
    assert.equal(r.passed, false, `Expected ${JSON.stringify(b)} to fail`);
    assert.equal(r.status, 400);
  }
});

test("joinMatchValidation requires valid 6-character roomCode", async () => {
  const valid = [{ roomCode: "ABC123" }, { roomCode: "XYZ999" }];
  for (const b of valid) {
    const r = await runValidation(joinMatchValidation, b);
    assert.equal(r.passed, true, `Expected ${JSON.stringify(b)} to pass`);
  }

  const invalid = [{ roomCode: "" }, { roomCode: "123" }, { roomCode: "TOOLONG123" }, { roomCode: "AB@#12" }];
  for (const b of invalid) {
    const r = await runValidation(joinMatchValidation, b);
    assert.equal(r.passed, false, `Expected ${JSON.stringify(b)} to fail`);
    assert.equal(r.status, 400);
  }
});

test("gameIdParamValidation accepts valid gameId parameters", async () => {
  const r1 = await runValidation(gameIdParamValidation, {}, { gameId: "6742db5e9a4f21001e3a9871" });
  assert.equal(r1.passed, true);

  const r2 = await runValidation(gameIdParamValidation, {}, { gameId: "ABC123" });
  assert.equal(r2.passed, true);

  const r3 = await runValidation(gameIdParamValidation, {}, { gameId: "   " });
  assert.equal(r3.passed, false);
});

test("formatSessionState builds complete authoritative state with tokens and turn info", () => {
  const dummySession = {
    _id: "6742db5e9a4f21001e3a9871",
    roomCode: "TEST66",
    gameMode: "twoPlayer",
    status: "in_progress",
    __v: 1,
    currentTurnPlayer: "6742d80b9a4f21001e3a9850",
    currentTurnSeat: 0,
    turnStatus: "WAITING_FOR_ROLL",
    lastDiceValue: null,
    consecutiveSixes: 0,
    turnDeadline: new Date(Date.now() + 15000),
    players: [
      {
        user: "6742d80b9a4f21001e3a9850",
        name: "Player 1",
        avatar: "",
        seatIndex: 0,
        color: "Red",
        score: 0,
        tokens: [
          { tokenId: 0, step: 0, isHome: false },
          { tokenId: 1, step: 0, isHome: false },
          { tokenId: 2, step: 0, isHome: false },
          { tokenId: 3, step: 0, isHome: false },
        ],
      },
      {
        user: "6742d80b9a4f21001e3a9851",
        name: "Player 2",
        avatar: "",
        seatIndex: 1,
        color: "Green",
        score: 0,
        tokens: [
          { tokenId: 0, step: 0, isHome: false },
          { tokenId: 1, step: 0, isHome: false },
          { tokenId: 2, step: 0, isHome: false },
          { tokenId: 3, step: 0, isHome: false },
        ],
      },
    ],
    winner: null,
  };

  const st = socketManager.formatSessionState(dummySession);
  assert.equal(st.sessionId, "6742db5e9a4f21001e3a9871");
  assert.equal(st.roomCode, "TEST66");
  assert.equal(st.players.length, 2);
  assert.equal(st.players[0].color, "Red");
  assert.equal(st.players[1].color, "Green");
  assert.equal(st.turn.seatIndex, 0);
  assert.equal(st.turn.status, "WAITING_FOR_ROLL");
  assert.ok(st.turn.remainingMs >= 0);
});
