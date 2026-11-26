"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const GameRoom = require("../../src/modules/rooms/models/GameRoom");
const GameSession = require("../../src/modules/games/models/GameSession");
const User = require("../../src/modules/auth/models/User");
const roomService = require("../../src/modules/rooms/services/room.service");
const roomController = require("../../src/modules/rooms/controllers/room.controller");
const gameService = require("../../src/modules/games/services/game.service");
const socketManager = require("../../src/sockets/socketManager");

// Mock Socket.IO Harness for session & turn tests
const setupMockHarness = () => {
  const userRooms = new Map(); // "user:<userId>" -> Set(MockSocket)
  const groupRooms = new Map(); // roomName -> Set(MockSocket)

  class MockSocket {
    constructor(userId, name) {
      this.id = `sock_${userId}_${Math.random().toString(36).slice(2, 7)}`;
      this.user = { _id: userId, name, username: name, avatar: "" };
      this.events = [];
      this.handlers = new Map();
      this.joinedRooms = new Set([`user:${userId}`]);

      if (!userRooms.has(`user:${userId}`)) {
        userRooms.set(`user:${userId}`, new Set());
      }
      userRooms.get(`user:${userId}`).add(this);
    }

    join(rooms) {
      const list = Array.isArray(rooms) ? rooms : [rooms];
      for (const r of list) {
        if (!r) continue;
        const key = String(r);
        this.joinedRooms.add(key);
        if (!groupRooms.has(key)) {
          groupRooms.set(key, new Set());
        }
        groupRooms.get(key).add(this);
      }
    }

    emit(event, payload) {
      this.events.push({ event, payload, timestamp: Date.now() });
    }

    on(event, handler) {
      this.handlers.set(event, handler);
    }

    async trigger(event, data) {
      const handler = this.handlers.get(event);
      if (!handler) return;
      return new Promise((resolve) => {
        let ackCalled = false;
        const ack = (res) => {
          ackCalled = true;
          resolve(res);
        };
        const res = handler(data, ack);
        if (res && typeof res.then === "function") {
          res.then(() => {
            if (!ackCalled) resolve();
          });
        } else if (!ackCalled) {
          resolve();
        }
      });
    }

    getEvents(name) {
      return this.events.filter((e) => e.event === name);
    }

    getLastEvent(name) {
      const evs = this.getEvents(name);
      return evs.length > 0 ? evs[evs.length - 1] : null;
    }

    clearEvents() {
      this.events = [];
    }
  }

  const mockIo = {
    to(targets) {
      const targetList = Array.isArray(targets) ? targets : [targets];
      const destSockets = new Set();
      for (const t of targetList) {
        const key = String(t);
        if (userRooms.has(key)) {
          for (const s of userRooms.get(key)) destSockets.add(s);
        }
        if (groupRooms.has(key)) {
          for (const s of groupRooms.get(key)) destSockets.add(s);
        }
      }
      return {
        emit(event, payload) {
          for (const s of destSockets) {
            s.emit(event, payload);
          }
        },
      };
    },
    in(userRoom) {
      const set = userRooms.get(String(userRoom)) || new Set();
      return {
        socketsJoin(targetRooms) {
          const list = Array.isArray(targetRooms) ? targetRooms : [targetRooms];
          for (const s of set) {
            s.join(list);
          }
        },
      };
    },
  };

  const server = require("node:http").createServer();
  socketManager.init(server);
  const realIo = socketManager.getIO();
  realIo.to = mockIo.to.bind(mockIo);
  realIo.in = mockIo.in.bind(mockIo);

  const hostUser = { _id: "6742d80b9a4f21001e3a9851", name: "Host Player" };
  const joinerUser = { _id: "6742d80b9a4f21001e3a9852", name: "Joiner Player" };

  const hostSocket = new MockSocket(hostUser._id, hostUser.name);
  const joinerSocket = new MockSocket(joinerUser._id, joinerUser.name);

  const connectionHandler = realIo.listeners("connection")[0];
  if (connectionHandler) {
    connectionHandler(hostSocket);
    connectionHandler(joinerSocket);
  }

  return { hostUser, joinerUser, hostSocket, joinerSocket, userRooms, groupRooms };
};

// Fixture builder for mock GameSession
const mkFixtureSession = (hostId, joinerId, overrides = {}) => {
  const session = {
    _id: "6742db5e9a4f21001e3a9899",
    room: "6742db5e9a4f21001e3a9898",
    roomCode: "HAND88",
    gameMode: "twoPlayer",
    status: "in_progress",
    __v: 1,
    actionSequence: 1,
    turnNumber: 1,
    currentTurnPlayer: hostId,
    currentTurnSeat: 0,
    turnStatus: "WAITING_FOR_ROLL",
    gamePhase: "waiting_for_roll",
    lastDiceValue: null,
    consecutiveSixes: 0,
    turnDeadline: new Date(Date.now() + 15000),
    history: [],
    players: [
      {
        user: hostId,
        name: "Host Player",
        avatar: "",
        seatIndex: 0,
        color: "Red",
        score: 0,
        missedTurns: 0,
        hasSurrendered: false,
        isHost: true,
        tokens: [
          { tokenId: 0, step: 0, isHome: false },
          { tokenId: 1, step: 0, isHome: false },
          { tokenId: 2, step: 0, isHome: false },
          { tokenId: 3, step: 0, isHome: false },
        ],
      },
      {
        user: joinerId,
        name: "Joiner Player",
        avatar: "",
        seatIndex: 1,
        color: "Green",
        score: 0,
        missedTurns: 0,
        hasSurrendered: false,
        isHost: false,
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

// Helper for Mock HTTP req/res
const createMockReqRes = (params = {}, body = {}, user = null) => {
  const req = { params, body, user };
  let statusCode = 200;
  let jsonResult = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      jsonResult = data;
      return this;
    },
  };
  return { req, res, getStatus: () => statusCode, getJson: () => jsonResult };
};

// ====================================================================
// TEST SUITE: Room Session Resolution & Authoritative Turn Handoff
// ====================================================================

test("1. Room details before match start returns sessionId: null, matchId: null, gameState: null", async () => {
  const origFindOneRoom = GameRoom.findOne;
  const origFindOneSession = GameSession.findOne;

  try {
    const mockRoom = {
      _id: "6742db5e9a4f21001e3a9898",
      roomCode: "HAND88",
      host: "6742d80b9a4f21001e3a9851",
      maxPlayers: 2,
      entryFee: 10,
      status: "waiting",
      players: [
        {
          user: { _id: "6742d80b9a4f21001e3a9851", name: "Host Player" },
          seatIndex: 0,
          color: "Red",
          isHost: true,
        },
      ],
    };

    GameRoom.findOne = () => ({
      populate: () => Promise.resolve(mockRoom),
    });
    // No active session before start
    GameSession.findOne = () => Promise.resolve(null);

    const { req, res, getStatus, getJson } = createMockReqRes(
      { roomCode: "HAND88" },
      {},
      { _id: "6742d80b9a4f21001e3a9851" }
    );

    await roomController.getRoomDetails(req, res);

    assert.equal(getStatus(), 200);
    const json = getJson();
    assert.equal(json.success, true);
    assert.equal(json.roomId, "HAND88");
    assert.equal(json.roomCode, "HAND88");
    assert.equal(json.sessionId, null);
    assert.equal(json.matchId, null);
    assert.equal(json.gameState, null);
    assert.equal(json.state, null);
    assert.equal(json.player.seatIndex, 0);
    assert.equal(json.player.color, "RED");
    assert.equal(json.player.isHost, true);
    assert.ok(json.data.room);
  } finally {
    GameRoom.findOne = origFindOneRoom;
    GameSession.findOne = origFindOneSession;
  }
});

test("2. Room details after session creation returns valid sessionId, matchId, gameState", async () => {
  const origFindOneRoom = GameRoom.findOne;
  const origFindOneSession = GameSession.findOne;

  try {
    const mockRoom = {
      _id: "6742db5e9a4f21001e3a9898",
      roomCode: "HAND88",
      host: "6742d80b9a4f21001e3a9851",
      maxPlayers: 2,
      entryFee: 10,
      status: "playing",
      players: [
        {
          user: { _id: "6742d80b9a4f21001e3a9851", name: "Host Player" },
          seatIndex: 0,
          color: "Red",
          isHost: true,
        },
        {
          user: { _id: "6742d80b9a4f21001e3a9852", name: "Joiner Player" },
          seatIndex: 1,
          color: "Green",
          isHost: false,
        },
      ],
    };

    const session = mkFixtureSession("6742d80b9a4f21001e3a9851", "6742d80b9a4f21001e3a9852");

    GameRoom.findOne = () => ({
      populate: () => Promise.resolve(mockRoom),
    });
    GameSession.findOne = (query) => {
      const match =
        query &&
        (query.room === mockRoom._id ||
          (query.$or && query.$or.some((c) => c.room === mockRoom._id || c.roomCode === mockRoom.roomCode)));
      if (match) {
        return Promise.resolve(session);
      }
      return Promise.resolve(null);
    };

    const { req, res, getStatus, getJson } = createMockReqRes(
      { roomCode: "HAND88" },
      {},
      { _id: "6742d80b9a4f21001e3a9851" }
    );

    await roomController.getRoomDetails(req, res);

    assert.equal(getStatus(), 200);
    const json = getJson();
    assert.equal(json.success, true);
    assert.equal(json.sessionId, String(session._id));
    assert.equal(json.matchId, String(session._id));
    assert.ok(json.gameState);
    assert.equal(json.player.userId, "6742d80b9a4f21001e3a9851");
    assert.equal(json.player.seatIndex, 0);
    assert.equal(json.player.color, "RED");
    assert.equal(json.player.isHost, true);
    assert.equal(json.data.sessionId, String(session._id));
  } finally {
    GameRoom.findOne = origFindOneRoom;
    GameSession.findOne = origFindOneSession;
  }
});

test("3. Correct sessionId and player identity returned for joining player (Seat 1 / GREEN)", async () => {
  const origFindOneRoom = GameRoom.findOne;
  const origFindOneSession = GameSession.findOne;

  try {
    const mockRoom = {
      _id: "6742db5e9a4f21001e3a9898",
      roomCode: "HAND88",
      host: "6742d80b9a4f21001e3a9851",
      maxPlayers: 2,
      entryFee: 10,
      status: "playing",
      players: [
        {
          user: { _id: "6742d80b9a4f21001e3a9851", name: "Host Player" },
          seatIndex: 0,
          color: "Red",
          isHost: true,
        },
        {
          user: { _id: "6742d80b9a4f21001e3a9852", name: "Joiner Player" },
          seatIndex: 1,
          color: "Green",
          isHost: false,
        },
      ],
    };

    const session = mkFixtureSession("6742d80b9a4f21001e3a9851", "6742d80b9a4f21001e3a9852");

    GameRoom.findOne = () => ({
      populate: () => Promise.resolve(mockRoom),
    });
    GameSession.findOne = (query) => {
      const match =
        query &&
        (query.room === mockRoom._id ||
          (query.$or && query.$or.some((c) => c.room === mockRoom._id || c.roomCode === mockRoom.roomCode)));
      if (match) {
        return Promise.resolve(session);
      }
      return Promise.resolve(null);
    };

    // Requested by the joining user
    const { req, res, getStatus, getJson } = createMockReqRes(
      { roomCode: "HAND88" },
      {},
      { _id: "6742d80b9a4f21001e3a9852" }
    );

    await roomController.getRoomDetails(req, res);

    assert.equal(getStatus(), 200);
    const json = getJson();
    assert.equal(json.sessionId, String(session._id));
    assert.equal(json.player.userId, "6742d80b9a4f21001e3a9852");
    assert.equal(json.player.seatIndex, 1);
    assert.equal(json.player.color, "GREEN");
    assert.equal(json.player.isHost, false);
    assert.equal(json.gameState.me.seatIndex, 1);
    assert.equal(json.gameState.me.color.toUpperCase(), "GREEN");
  } finally {
    GameRoom.findOne = origFindOneRoom;
    GameSession.findOne = origFindOneSession;
  }
});

test("4. No sessionId leakage from another room and completed/expired sessions are not attached", async () => {
  const origFindOneRoom = GameRoom.findOne;
  const origFindOneSession = GameSession.findOne;

  try {
    const mockRoom = {
      _id: "6742db5e9a4f21001e3a9898",
      roomCode: "HAND88",
      host: "6742d80b9a4f21001e3a9851",
      maxPlayers: 2,
      entryFee: 10,
      status: "waiting",
      players: [
        {
          user: { _id: "6742d80b9a4f21001e3a9851", name: "Host Player" },
          seatIndex: 0,
          color: "Red",
          isHost: true,
        },
      ],
    };

    // Session from another room
    const otherRoomSession = {
      _id: "6742db5e9a4f21001e3a9999",
      room: "6742db5e9a4f21001e3a7777", // Different room!
      status: "in_progress",
    };

    GameRoom.findOne = () => ({
      populate: () => Promise.resolve(mockRoom),
    });
    // Strict query check: room._id must match
    GameSession.findOne = (query) => {
      const match =
        query &&
        (query.room === mockRoom._id ||
          (query.$or && query.$or.some((c) => c.room === mockRoom._id || c.roomCode === mockRoom.roomCode)));
      if (match) {
        return Promise.resolve(null); // No active session for this room
      }
      return Promise.resolve(otherRoomSession);
    };

    const details = await roomService.getRoomDetails("HAND88");
    assert.equal(details.session, null, "Must not return session belonging to another room");

    // Case 2: Session for this room is completed/finished
    GameSession.findOne = (query) => {
      const isProgressQuery =
        query &&
        (query.status === "in_progress" || (query.status?.$in && query.status.$in.includes("in_progress")));
      if (isProgressQuery) {
        return Promise.resolve(null); // Only in_progress sessions are active
      }
      return Promise.resolve({ _id: "6742db5e9a4f21001e3a9899", room: mockRoom._id, status: "finished" });
    };

    const detailsFinished = await roomService.getRoomDetails("HAND88");
    assert.equal(detailsFinished.session, null, "Must not attach finished session as active");
  } finally {
    GameRoom.findOne = origFindOneRoom;
    GameSession.findOne = origFindOneSession;
  }
});

test("5. No legal move causes turn advance automatically", async () => {
  const origFindById = GameSession.findById;
  const origRollDie = require("../../utils/secureRandom").rollDie;

  try {
    const hostId = "6742d80b9a4f21001e3a9851";
    const joinerId = "6742d80b9a4f21001e3a9852";
    const session = mkFixtureSession(hostId, joinerId, {
      currentTurnPlayer: hostId,
      currentTurnSeat: 0,
      turnStatus: "WAITING_FOR_ROLL",
      gamePhase: "waiting_for_roll",
    });
    // Set all tokens to step -1 (in base) so rolling 4 has no legal moves
    session.players[0].tokens = [
      { tokenId: 0, step: -1, isHome: false },
      { tokenId: 1, step: -1, isHome: false },
      { tokenId: 2, step: -1, isHome: false },
      { tokenId: 3, step: -1, isHome: false },
    ];

    GameSession.findById = () => session;
    // Force roll of 4 (all tokens are at step 0 in classic mode, no legal move)
    require("../../utils/secureRandom").rollDie = () => 4;

    const res = await gameService.rollDice(hostId, session._id, { actionId: "act_no_legal_1" });

    assert.equal(res.data.diceValue, 4);
    assert.equal(res.data.turnPassed, true, "Turn must automatically pass when no legal move exists");
    assert.deepEqual(res.data.legalMoves, []);
    assert.equal(String(session.currentTurnPlayer), joinerId, "Turn must advance to Joiner");
    assert.equal(session.currentTurnSeat, 1, "Seat must advance to 1");
  } finally {
    GameSession.findById = origFindById;
    require("../../utils/secureRandom").rollDie = origRollDie;
  }
});

test("6. Both players receive updated state and turn_changed on authoritative turn handoff", async () => {
  const { hostUser, joinerUser, hostSocket, joinerSocket } = setupMockHarness();
  const origFindById = GameSession.findById;
  const origFindOne = GameSession.findOne;
  const origRollDie = require("../../utils/secureRandom").rollDie;

  try {
    const session = mkFixtureSession(hostUser._id, joinerUser._id, {
      currentTurnPlayer: hostUser._id,
      currentTurnSeat: 0,
      turnStatus: "WAITING_FOR_ROLL",
      gamePhase: "waiting_for_roll",
    });
    session.players[0].tokens = [
      { tokenId: 0, step: -1, isHome: false },
      { tokenId: 1, step: -1, isHome: false },
      { tokenId: 2, step: -1, isHome: false },
      { tokenId: 3, step: -1, isHome: false },
    ];

    GameSession.findById = () => session;
    GameSession.findOne = () => Promise.resolve(session);
    // Force roll of 3 (no legal moves for tokens at step 0)
    require("../../utils/secureRandom").rollDie = () => 3;

    hostSocket.join(["HAND88", `session:${session._id}`]);
    joinerSocket.join(["HAND88", `session:${session._id}`]);

    let rollAck = null;
    await hostSocket.trigger("roll_dice", {
      sessionId: String(session._id),
      actionId: "act_roll_hand_1",
    }).then((ack) => {
      rollAck = ack;
    });

    // Check host events
    const hostTurnEvents = hostSocket.getEvents("turn_changed");
    const joinerTurnEvents = joinerSocket.getEvents("turn_changed");
    assert.ok(hostTurnEvents.length > 0, "Host must receive turn_changed");
    assert.ok(joinerTurnEvents.length > 0, "Joiner must receive turn_changed");

    const hostTurn = hostTurnEvents[hostTurnEvents.length - 1].payload;
    const joinerTurn = joinerTurnEvents[joinerTurnEvents.length - 1].payload;

    assert.equal(hostTurn.currentTurnPlayer, String(joinerUser._id));
    assert.equal(joinerTurn.currentTurnPlayer, String(joinerUser._id));
    assert.equal(hostTurn.currentTurnSeat, 1);
    assert.equal(joinerTurn.currentTurnSeat, 1);
    assert.equal(hostTurn.stateVersion, joinerTurn.stateVersion);

    // Check game_state events
    const hostStateEvents = hostSocket.getEvents("game_state");
    const joinerStateEvents = joinerSocket.getEvents("game_state");
    assert.ok(hostStateEvents.length > 0, "Host must receive game_state");
    assert.ok(joinerStateEvents.length > 0, "Joiner must receive game_state");

    const hostState = hostStateEvents[hostStateEvents.length - 1].payload;
    const joinerState = joinerStateEvents[joinerStateEvents.length - 1].payload;
    assert.equal(hostState.currentTurnPlayer, String(joinerUser._id));
    assert.equal(joinerState.currentTurnPlayer, String(joinerUser._id));
    assert.equal(hostState.sessionId, String(session._id));
  } finally {
    GameSession.findById = origFindById;
    GameSession.findOne = origFindOne;
    require("../../utils/secureRandom").rollDie = origRollDie;
  }
});

test("7. Legal move remains available after a roll (waiting for move, turn does not advance)", async () => {
  const origFindById = GameSession.findById;
  const origRollDie = require("../../utils/secureRandom").rollDie;

  try {
    const hostId = "6742d80b9a4f21001e3a9851";
    const joinerId = "6742d80b9a4f21001e3a9852";
    const session = mkFixtureSession(hostId, joinerId, {
      currentTurnPlayer: hostId,
      currentTurnSeat: 0,
      turnStatus: "WAITING_FOR_ROLL",
      gamePhase: "waiting_for_roll",
    });
    // Set all tokens to step -1 (in base) so rolling 4 has no legal moves
    session.players[0].tokens = [
      { tokenId: 0, step: -1, isHome: false },
      { tokenId: 1, step: -1, isHome: false },
      { tokenId: 2, step: -1, isHome: false },
      { tokenId: 3, step: -1, isHome: false },
    ];

    GameSession.findById = () => session;
    // Force roll of 6 (can open any token at step 0)
    require("../../utils/secureRandom").rollDie = () => 6;

    const res = await gameService.rollDice(hostId, session._id, { actionId: "act_legal_roll_6" });

    assert.equal(res.data.diceValue, 6);
    assert.equal(res.data.turnPassed, false, "Turn must not pass when legal moves exist");
    assert.ok(res.data.legalMoves.length > 0, "Legal moves must be populated");
    assert.equal(res.data.gamePhase, "waiting_for_move");
    assert.equal(res.data.turnStatus, "WAITING_FOR_MOVE");
    assert.equal(String(session.currentTurnPlayer), hostId, "Turn must remain with Host");
  } finally {
    GameSession.findById = origFindById;
    require("../../utils/secureRandom").rollDie = origRollDie;
  }
});

test("8. Six follows existing extra-turn rules (player moves token and keeps turn)", async () => {
  const origFindById = GameSession.findById;
  const origRollDie = require("../../utils/secureRandom").rollDie;

  try {
    const hostId = "6742d80b9a4f21001e3a9851";
    const joinerId = "6742d80b9a4f21001e3a9852";
    const session = mkFixtureSession(hostId, joinerId, {
      currentTurnPlayer: hostId,
      currentTurnSeat: 0,
      turnStatus: "WAITING_FOR_ROLL",
      gamePhase: "waiting_for_roll",
    });
    // Set all tokens to step -1 (in base) so rolling 4 has no legal moves
    session.players[0].tokens = [
      { tokenId: 0, step: -1, isHome: false },
      { tokenId: 1, step: -1, isHome: false },
      { tokenId: 2, step: -1, isHome: false },
      { tokenId: 3, step: -1, isHome: false },
    ];

    GameSession.findById = () => session;
    // Roll a 6
    require("../../utils/secureRandom").rollDie = () => 6;
    await gameService.rollDice(hostId, session._id, { actionId: "act_six_1" });

    // Host moves token 0 from step 0 to step 1
    const moveRes = await gameService.moveToken(hostId, session._id, 0, { actionId: "act_move_six_1" });

    assert.equal(moveRes.data.move.getsExtraTurn, true, "Rolling a 6 grants a bonus turn");
    assert.equal(String(session.currentTurnPlayer), hostId, "Player keeps turn after rolling 6");
    assert.equal(session.currentTurnSeat, 0);
    assert.equal(session.turnStatus, "WAITING_FOR_ROLL", "Player can roll again");
  } finally {
    GameSession.findById = origFindById;
    require("../../utils/secureRandom").rollDie = origRollDie;
  }
});

test("9. Duplicate roll cannot advance multiple turns (idempotency and phase check)", async () => {
  const origFindById = GameSession.findById;
  const origRollDie = require("../../utils/secureRandom").rollDie;

  try {
    const hostId = "6742d80b9a4f21001e3a9851";
    const joinerId = "6742d80b9a4f21001e3a9852";
    const session = mkFixtureSession(hostId, joinerId, {
      currentTurnPlayer: hostId,
      currentTurnSeat: 0,
      turnStatus: "WAITING_FOR_ROLL",
      gamePhase: "waiting_for_roll",
    });
    // Set all tokens to step -1 (in base) so rolling 4 has no legal moves
    session.players[0].tokens = [
      { tokenId: 0, step: -1, isHome: false },
      { tokenId: 1, step: -1, isHome: false },
      { tokenId: 2, step: -1, isHome: false },
      { tokenId: 3, step: -1, isHome: false },
    ];

    GameSession.findById = () => session;
    require("../../utils/secureRandom").rollDie = () => 6;

    // First roll
    const res1 = await gameService.rollDice(hostId, session._id, { actionId: "act_idemp_1" });
    assert.equal(res1.data.diceValue, 6);

    // Duplicate roll with SAME actionId returns idempotent result
    const resDuplicate = await gameService.rollDice(hostId, session._id, { actionId: "act_idemp_1" });
    assert.equal(resDuplicate.message, "Action already processed");
    assert.equal(resDuplicate.data.diceValue, 6);
    assert.equal(String(session.currentTurnPlayer), hostId);

    // Attempting another roll with DIFFERENT actionId while still waiting for move throws ALREADY_ROLLED
    await assert.rejects(
      async () => {
        await gameService.rollDice(hostId, session._id, { actionId: "act_idemp_2" });
      },
      (err) => {
        assert.equal(err.code, "ALREADY_ROLLED");
        return true;
      }
    );
  } finally {
    GameSession.findById = origFindById;
    require("../../utils/secureRandom").rollDie = origRollDie;
  }
});

test("10. stateVersion increases correctly on dice roll and move", async () => {
  const origFindById = GameSession.findById;
  const origRollDie = require("../../utils/secureRandom").rollDie;

  try {
    const hostId = "6742d80b9a4f21001e3a9851";
    const joinerId = "6742d80b9a4f21001e3a9852";
    const session = mkFixtureSession(hostId, joinerId, {
      currentTurnPlayer: hostId,
      currentTurnSeat: 0,
      turnStatus: "WAITING_FOR_ROLL",
      gamePhase: "waiting_for_roll",
      actionSequence: 5,
    });

    GameSession.findById = () => session;
    require("../../utils/secureRandom").rollDie = () => 6;

    // Roll increments stateVersion
    const rollRes = await gameService.rollDice(hostId, session._id, { actionId: "act_v_1" });
    assert.equal(rollRes.data.actionSequence, 6);
    assert.equal(session.actionSequence, 6);

    // Move increments stateVersion again
    const moveRes = await gameService.moveToken(hostId, session._id, 0, { actionId: "act_v_2" });
    assert.equal(moveRes.data.actionSequence, 7);
    assert.equal(session.actionSequence, 7);
  } finally {
    GameSession.findById = origFindById;
    require("../../utils/secureRandom").rollDie = origRollDie;
  }
});

test("11. Reconnect restores current session and turn without seat change and does not leak private 'me'", async () => {
  const { hostUser, joinerUser, hostSocket, joinerSocket } = setupMockHarness();
  const origFindById = GameSession.findById;
  const origFindOne = GameSession.findOne;

  try {
    const session = mkFixtureSession(hostUser._id, joinerUser._id, {
      currentTurnPlayer: joinerUser._id,
      currentTurnSeat: 1,
      turnStatus: "WAITING_FOR_ROLL",
    });

    GameSession.findById = () => session;
    GameSession.findOne = () => Promise.resolve(session);

    hostSocket.join(["HAND88", `session:${session._id}`]);

    // Joiner reconnects with new socket
    const newJoinerSocket = new (joinerSocket.constructor)(joinerUser._id, joinerUser.name);
    // Wire up handlers for new socket
    socketManager.init(); // ensure io is available
    const realIo = socketManager.getIO();
    // Simulate connection handler registration
    const connectionHandler = realIo.listeners("connection")[0];
    if (connectionHandler) connectionHandler(newJoinerSocket);

    await newJoinerSocket.trigger("join_session", {
      sessionId: String(session._id),
      roomCode: "HAND88",
    });

    // Verify reconnecting socket received its own game_state with me: Joiner (seat 1)
    const myStateEvents = newJoinerSocket.getEvents("game_state");
    assert.ok(myStateEvents.length > 0);
    const lastMyState = myStateEvents[myStateEvents.length - 1].payload;
    assert.equal(lastMyState.me.seatIndex, 1);
    assert.equal(lastMyState.me.color.toUpperCase(), "GREEN");

    // Verify host received player_reconnected broadcast WITHOUT private 'me' of joiner
    const hostReconnectedEvents = hostSocket.getEvents("player_reconnected");
    assert.ok(hostReconnectedEvents.length > 0);
    const lastHostRecv = hostReconnectedEvents[hostReconnectedEvents.length - 1].payload;
    assert.equal(lastHostRecv.me, undefined, "Private 'me' must NOT be leaked to other room players");
    assert.equal(lastHostRecv.currentTurnPlayer, String(joinerUser._id));
  } finally {
    GameSession.findById = origFindById;
    GameSession.findOne = origFindOne;
  }
});

test("12. Event ordering does not deadlock with concurrent requests", async () => {
  const { hostUser, joinerUser, hostSocket } = setupMockHarness();
  const origFindById = GameSession.findById;
  const origFindOne = GameSession.findOne;
  const origRollDie = require("../../utils/secureRandom").rollDie;

  try {
    const session = mkFixtureSession(hostUser._id, joinerUser._id, {
      currentTurnPlayer: hostUser._id,
      currentTurnSeat: 0,
      turnStatus: "WAITING_FOR_ROLL",
      gamePhase: "waiting_for_roll",
    });
    session.players[0].tokens = [
      { tokenId: 0, step: -1, isHome: false },
      { tokenId: 1, step: -1, isHome: false },
      { tokenId: 2, step: -1, isHome: false },
      { tokenId: 3, step: -1, isHome: false },
    ];

    GameSession.findById = () => session;
    GameSession.findOne = () => Promise.resolve(session);
    require("../../utils/secureRandom").rollDie = () => 6;

    hostSocket.join(["HAND88", `session:${session._id}`]);

    // Send 3 concurrent requests simultaneously through session lock
    const p1 = hostSocket.trigger("roll_dice", {
      sessionId: String(session._id),
      actionId: "act_concurrent_1",
    });
    const p2 = hostSocket.trigger("roll_dice", {
      sessionId: String(session._id),
      actionId: "act_concurrent_1", // duplicate actionId
    });
    const p3 = hostSocket.trigger("roll_dice", {
      sessionId: String(session._id),
      actionId: "act_concurrent_2", // subsequent actionId
    });

    const results = await Promise.allSettled([p1, p2, p3]);
    assert.equal(results.every((r) => r.status === "fulfilled"), true, "Concurrent actions must not deadlock");
  } finally {
    GameSession.findById = origFindById;
    GameSession.findOne = origFindOne;
    require("../../utils/secureRandom").rollDie = origRollDie;
  }
});
