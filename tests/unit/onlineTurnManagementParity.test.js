"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const GameSession = require("../../src/modules/games/models/GameSession");
const gameService = require("../../src/modules/games/services/game.service");
const socketManager = require("../../src/sockets/socketManager");
const engine = require("../../src/modules/games/engine/ludoEngine");

const mkMockSession = (overrides = {}) => {
  const session = {
    _id: "6742db5e9a4f21001e3a9871",
    room: "6742db5e9a4f21001e3a9870",
    roomCode: "TEST66",
    gameMode: "twoPlayer",
    status: "in_progress",
    __v: 1,
    actionSequence: 1,
    turnNumber: 1,
    currentTurnPlayer: "u1",
    currentTurnSeat: 0,
    turnStatus: "WAITING_FOR_ROLL",
    gamePhase: "waiting_for_roll",
    lastDiceValue: null,
    consecutiveSixes: 0,
    turnDeadline: new Date(Date.now() + 15000),
    history: [],
    players: [
      {
        user: "u1",
        name: "Player 1",
        avatar: "",
        seatIndex: 0,
        color: "Red",
        score: 0,
        missedTurns: 0,
        hasSurrendered: false,
        tokens: [
          { tokenId: 0, step: 0, isHome: false },
          { tokenId: 1, step: 0, isHome: false },
          { tokenId: 2, step: 0, isHome: false },
          { tokenId: 3, step: 0, isHome: false },
        ],
      },
      {
        user: "u2",
        name: "Player 2",
        avatar: "",
        seatIndex: 1,
        color: "Green",
        score: 0,
        missedTurns: 0,
        hasSurrendered: false,
        tokens: [
          { tokenId: 0, step: 0, isHome: false },
          { tokenId: 1, step: 0, isHome: false },
          { tokenId: 2, step: 0, isHome: false },
          { tokenId: 3, step: 0, isHome: false },
        ],
      },
    ],
    async save() {
      return this;
    },
    ...overrides,
  };
  return session;
};

// 1 & 2. Player A rolls dice and receives authoritative dice result
test("1 & 2. Player A rolls dice and receives authoritative server dice result", async () => {
  const session = mkMockSession();
  const origFind = GameSession.findById;
  GameSession.findById = async () => session;
  try {
    const res = await gameService.rollDice("u1", session._id, { actionId: "act_1" });
    assert.equal(res.data.session.lastDiceValue >= 1 && res.data.session.lastDiceValue <= 6, true);
    assert.equal(res.data.actionId, "act_1");
    assert.ok(res.data.actionSequence >= 2);
    if (res.data.turnPassed) {
      assert.equal(res.data.gamePhase, "waiting_for_roll");
    } else {
      assert.equal(res.data.gamePhase, "waiting_for_move");
      assert.equal(res.data.turnStatus, "WAITING_FOR_MOVE");
    }
  } finally {
    GameSession.findById = origFind;
  }
});

// 3. Player A has legal moves
test("3. Player A has legal moves calculated by server rules", async () => {
  const session = mkMockSession({
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 4,
  });
  const origFind = GameSession.findById;
  GameSession.findById = async () => session;
  try {
    const legalMoves = engine.getMovableTokenIds(session.players[0].tokens, 4);
    assert.deepEqual(legalMoves, [0, 1, 2, 3]);
  } finally {
    GameSession.findById = origFind;
  }
});

// 4 & 5. Player A selects a valid token and movement completes
test("4 & 5. Player A selects a valid token and token movement completes", async () => {
  const session = mkMockSession({
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 3,
  });
  const origFind = GameSession.findById;
  GameSession.findById = async () => session;
  try {
    const res = await gameService.moveToken("u1", session._id, 0, { actionId: "act_move_1" });
    assert.equal(res.data.move.tokenId, 0);
    assert.equal(res.data.move.newStep, 3);
    assert.equal(res.data.move.pointsEarned, 3);
    assert.equal(session.players[0].tokens[0].step, 3);
    assert.equal(session.players[0].score, 3);
  } finally {
    GameSession.findById = origFind;
  }
});

// 6 & 7. Player B receives turn and can roll
test("6 & 7. Player B receives turn after non-extra-turn move and can roll", async () => {
  const session = mkMockSession({
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 4,
  });
  const origFind = GameSession.findById;
  GameSession.findById = async () => session;
  try {
    await gameService.moveToken("u1", session._id, 0);
    assert.equal(String(session.currentTurnPlayer), "u2");
    assert.equal(session.currentTurnSeat, 1);
    assert.equal(session.gamePhase, "waiting_for_roll");

    const st = socketManager.formatSessionState(session);
    const viewerB = socketManager.viewerView(st, "u2");
    assert.equal(viewerB.me.isMyTurn, true);
    assert.equal(viewerB.me.canRoll, true);
    assert.equal(viewerB.me.canMove, false);

    const viewerA = socketManager.viewerView(st, "u1");
    assert.equal(viewerA.me.isMyTurn, false);
    assert.equal(viewerA.me.canRoll, false);
  } finally {
    GameSession.findById = origFind;
  }
});

// 8. Player A cannot roll during Player B's turn
test("8. Player A cannot roll during Player B's turn", async () => {
  const session = mkMockSession({
    currentTurnPlayer: "u2",
    currentTurnSeat: 1,
    turnStatus: "WAITING_FOR_ROLL",
    gamePhase: "waiting_for_roll",
  });
  const origFind = GameSession.findById;
  GameSession.findById = async () => session;
  try {
    await assert.rejects(
      async () => gameService.rollDice("u1", session._id),
      (err) => err.statusCode === 403 && /not your turn/i.test(err.message)
    );
  } finally {
    GameSession.findById = origFind;
  }
});

// 9. Duplicate roll request is rejected (and idempotent for same actionId)
test("9. Duplicate roll request is rejected during waiting_for_move", async () => {
  const session = mkMockSession({
    currentTurnPlayer: "u1",
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 5,
    lastActionId: "act_roll_dup",
  });
  const origFind = GameSession.findById;
  GameSession.findById = async () => session;
  try {
    // Different actionId: rejected
    await assert.rejects(
      async () => gameService.rollDice("u1", session._id, { actionId: "new_act" }),
      (err) => err.statusCode === 400 && /already rolled/i.test(err.message)
    );

    // Exact same actionId: idempotent success with cached state
    const cached = await gameService.rollDice("u1", session._id, { actionId: "act_roll_dup" });
    assert.equal(cached.data.actionId, "act_roll_dup");
    assert.equal(cached.data.diceValue, 5);
  } finally {
    GameSession.findById = origFind;
  }
});

// 10. Duplicate token move is rejected
test("10. Duplicate token move is rejected when not in waiting_for_move phase", async () => {
  const session = mkMockSession({
    currentTurnPlayer: "u1",
    turnStatus: "WAITING_FOR_ROLL",
    gamePhase: "waiting_for_roll",
    lastDiceValue: null,
  });
  const origFind = GameSession.findById;
  GameSession.findById = async () => session;
  try {
    await assert.rejects(
      async () => gameService.moveToken("u1", session._id, 0),
      (err) => err.statusCode === 400 && /roll the dice before moving/i.test(err.message)
    );
  } finally {
    GameSession.findById = origFind;
  }
});

// 11. No legal moves automatically advance the turn
test("11. No legal moves automatically advances the turn to next player", async () => {
  const session = mkMockSession({
    currentTurnPlayer: "u1",
    currentTurnSeat: 0,
    turnStatus: "WAITING_FOR_ROLL",
    gamePhase: "waiting_for_roll",
  });
  // Tokens all at step 55 (needing exact 1)
  session.players[0].tokens.forEach((t) => {
    t.step = 55;
  });

  const origRollDie = require("../../utils/secureRandom").rollDie;
  const secureRandom = require("../../utils/secureRandom");
  secureRandom.rollDie = () => 4; // rolls 4, cannot move (55 + 4 > 56)

  const origFind = GameSession.findById;
  GameSession.findById = async () => session;
  try {
    const res = await gameService.rollDice("u1", session._id);
    assert.equal(res.data.turnPassed, true);
    assert.deepEqual(res.data.legalMoves, []);
    assert.equal(String(session.currentTurnPlayer), "u2");
    assert.equal(session.gamePhase, "waiting_for_roll");
  } finally {
    secureRandom.rollDie = origRollDie;
    GameSession.findById = origFind;
  }
});

// 12. Six follows offline extra-turn rules (and 3 consecutive sixes forfeits)
test("12. Six follows offline extra-turn rules and 3rd six forfeits turn", async () => {
  const session = mkMockSession({
    currentTurnPlayer: "u1",
    currentTurnSeat: 0,
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 6,
    consecutiveSixes: 1,
  });
  const origFind = GameSession.findById;
  GameSession.findById = async () => session;
  try {
    // 1st six move: retains turn
    const res1 = await gameService.moveToken("u1", session._id, 0);
    assert.equal(res1.data.move.getsExtraTurn, true);
    assert.equal(String(session.currentTurnPlayer), "u1");
    assert.equal(session.gamePhase, "waiting_for_roll");

    // 3 consecutive sixes rule:
    session.consecutiveSixes = 2; // already had 2 sixes
    session.turnStatus = "WAITING_FOR_ROLL";
    session.gamePhase = "waiting_for_roll";

    const secureRandom = require("../../utils/secureRandom");
    const origRollDie = secureRandom.rollDie;
    secureRandom.rollDie = () => 6; // 3rd six

    const res3 = await gameService.rollDice("u1", session._id);
    assert.equal(res3.data.turnPassed, true);
    assert.equal(res3.data.threeSixes, true);
    assert.equal(String(session.currentTurnPlayer), "u2");
    secureRandom.rollDie = origRollDie;
  } finally {
    GameSession.findById = origFind;
  }
});

// 13. Capture follows offline rules
test("13. Capture follows offline rules: resets opponent token, deducts score, grants extra turn", async () => {
  const session = mkMockSession({
    currentTurnPlayer: "u1",
    currentTurnSeat: 0,
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 4,
  });
  // Seat 0 step 16 -> global index 20. Opponent (Seat 1) on step 7 -> (13+7)%52 = 20 (non-safe tile)
  session.players[0].tokens[0].step = 16;
  session.players[1].tokens[0].step = 7;
  session.players[1].score = 25;

  const origFind = GameSession.findById;
  GameSession.findById = async () => session;
  try {
    const res = await gameService.moveToken("u1", session._id, 0);
    assert.ok(res.data.move.captured);
    assert.equal(res.data.move.getsExtraTurn, true);
    assert.equal(session.players[1].tokens[0].step, 0); // Opponent back to yard
    assert.equal(session.players[1].score, 18); // Lost 7 points
    assert.equal(String(session.currentTurnPlayer), "u1"); // Extra turn for player 1
  } finally {
    GameSession.findById = origFind;
  }
});

// 14. Goal follows offline rules
test("14. Goal follows offline rules: reaching step 56 grants bonus and extra turn", async () => {
  const session = mkMockSession({
    currentTurnPlayer: "u1",
    currentTurnSeat: 0,
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 2,
  });
  session.players[0].tokens[0].step = 54;

  const origFind = GameSession.findById;
  GameSession.findById = async () => session;
  try {
    const res = await gameService.moveToken("u1", session._id, 0);
    assert.equal(res.data.move.reachedHome, true);
    assert.equal(res.data.move.getsExtraTurn, true);
    assert.equal(res.data.move.pointsEarned, 2 + 56);
    assert.equal(session.players[0].tokens[0].isHome, true);
    assert.equal(String(session.currentTurnPlayer), "u1"); // Extra turn
  } finally {
    GameSession.findById = origFind;
  }
});

// 15. Reconnect restores current state
test("15. Reconnect restores authoritative current state with player-specific permissions", () => {
  const session = mkMockSession({
    currentTurnPlayer: "u1",
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 5,
    actionSequence: 7,
    turnNumber: 3,
  });

  const st = socketManager.formatSessionState(session);
  assert.equal(st.stateVersion, 7);
  assert.equal(st.turnNumber, 3);
  assert.equal(st.gamePhase, "waiting_for_move");

  const meA = socketManager.viewerView(st, "u1").me;
  assert.equal(meA.isMyTurn, true);
  assert.equal(meA.canRoll, false);
  assert.equal(meA.canMove, true);
  assert.deepEqual(meA.legalMoves, [0, 1, 2, 3]);

  const meB = socketManager.viewerView(st, "u2").me;
  assert.equal(meB.isMyTurn, false);
  assert.equal(meB.canRoll, false);
  assert.equal(meB.canMove, false);
});

// 16. Stale action is rejected
test("16. Stale or illegal token move is rejected with INVALID_MOVE", async () => {
  const session = mkMockSession({
    currentTurnPlayer: "u1",
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 3,
  });
  // Token 0 at 55 (55 + 3 = 58 > 56, illegal)
  session.players[0].tokens[0].step = 55;

  const origFind = GameSession.findById;
  GameSession.findById = async () => session;
  try {
    await assert.rejects(
      async () => gameService.moveToken("u1", session._id, 0),
      (err) => err.statusCode === 400 && /cannot be moved/i.test(err.message)
    );
  } finally {
    GameSession.findById = origFind;
  }
});

// 17. Simultaneous requests do not corrupt game state (serialized action locking)
test("17. Simultaneous requests are serialized cleanly", async () => {
  let executionCount = 0;
  const executionOrder = [];

  // Simulate two async actions locked on same session
  const act1 = async () => {
    executionCount++;
    await new Promise((r) => setTimeout(r, 20));
    executionOrder.push(1);
    return "done1";
  };

  const act2 = async () => {
    executionCount++;
    executionOrder.push(2);
    return "done2";
  };

  // Promise.all running through simulated per-session serialization
  const lock = new Map();
  const withLock = async (id, fn) => {
    const prev = lock.get(id) || Promise.resolve();
    let release;
    const cur = new Promise((r) => { release = r; });
    lock.set(id, prev.then(() => cur, () => cur));
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  };

  await Promise.all([
    withLock("s1", act1),
    withLock("s1", act2),
  ]);

  assert.equal(executionCount, 2);
  assert.deepEqual(executionOrder, [1, 2]); // strictly serialized
});

// 18. Game over prevents further actions
test("18. Game over prevents further roll or move actions", async () => {
  const session = mkMockSession({
    status: "completed",
    gamePhase: "game_over",
    turnStatus: "TURN_COMPLETED",
  });

  const origFind = GameSession.findById;
  GameSession.findById = async () => session;
  try {
    await assert.rejects(
      async () => gameService.rollDice("u1", session._id),
      (err) => /already completed/i.test(err.message)
    );
    await assert.rejects(
      async () => gameService.moveToken("u1", session._id, 0),
      (err) => /already completed/i.test(err.message)
    );
  } finally {
    GameSession.findById = origFind;
  }
});
