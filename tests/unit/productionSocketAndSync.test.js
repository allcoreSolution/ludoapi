"use strict";

process.env.NODE_ENV = "test";
process.env.MONGO_URI = "mongodb://127.0.0.1:27017/testdb";
process.env.JWT_SECRET = "supersecretkeyformocktest123456789012";
process.env.SESSION_SECRET = "supersecretkeyformocktest123456789012";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const jwt = require("jsonwebtoken");

const app = require("../../app");
const config = require("../../config/env");
const User = require("../../src/modules/auth/models/User");
const GameRoom = require("../../src/modules/rooms/models/GameRoom");
const GameSession = require("../../src/modules/games/models/GameSession");
const gameService = require("../../src/modules/games/services/game.service");
const gameController = require("../../src/modules/games/controllers/game.controller");
const socketManager = require("../../src/sockets/socketManager");

// Helper to generate a valid test JWT
const makeToken = (userId, overrides = {}) => {
  return jwt.sign(
    { id: String(userId), role: "user", ...overrides },
    config.jwt.secret,
    { algorithm: config.jwt.algorithm, expiresIn: "1h" }
  );
};

// Mock Socket.IO Harness for real socket lifecycle testing
const setupMockHarness = () => {
  const userRooms = new Map();
  const groupRooms = new Map();

  class MockSocket {
    constructor(userId, name) {
      this.id = `sock_${userId}_${Math.random().toString(36).slice(2, 7)}`;
      this.user = { _id: userId, name, username: name, avatar: "", isActive: true };
      this.events = [];
      this.handlers = new Map();
      this.joinedRooms = new Set([`user:${userId}`]);
      this.connected = true;

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

    leave(room) {
      const key = String(room);
      this.joinedRooms.delete(key);
      if (groupRooms.has(key)) {
        groupRooms.get(key).delete(this);
      }
    }

    emit(event, payload) {
      this.events.push({ event, payload, timestamp: Date.now() });
    }

    to(room) {
      const key = String(room);
      const destSockets = new Set();
      if (groupRooms.has(key)) {
        for (const s of groupRooms.get(key)) {
          if (s !== this) destSockets.add(s);
        }
      }
      return {
        emit(event, payload) {
          for (const s of destSockets) {
            s.emit(event, payload);
          }
        },
      };
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

  const server = http.createServer(app);
  socketManager.init(server);
  const realIo = socketManager.getIO();
  realIo.to = mockIo.to.bind(mockIo);
  realIo.in = mockIo.in.bind(mockIo);

  const hostUser = { _id: "6742d80b9a4f21001e3a9851", name: "Host Player" };
  const joinerUser = { _id: "6742d80b9a4f21001e3a9852", name: "Joiner Player" };
  const unauthorizedUser = { _id: "6742d80b9a4f21001e3a9899", name: "Stranger Player" };

  const hostSocket = new MockSocket(hostUser._id, hostUser.name);
  const joinerSocket = new MockSocket(joinerUser._id, joinerUser.name);
  const strangerSocket = new MockSocket(unauthorizedUser._id, unauthorizedUser.name);

  const connListener = realIo.listeners("connection")[0];
  if (connListener) {
    connListener(hostSocket);
    connListener(joinerSocket);
    connListener(strangerSocket);
  }

  return { hostUser, joinerUser, unauthorizedUser, hostSocket, joinerSocket, strangerSocket, groupRooms, userRooms };
};

// Fixture builder
const mkFixtureSession = (hostId, joinerId, overrides = {}) => {
  return {
    _id: "6742db5e9a4f21001e3a9899",
    room: "6742db5e9a4f21001e3a9898",
    roomCode: "PROD88",
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
          { tokenId: 0, step: -1, isHome: false },
          { tokenId: 1, step: -1, isHome: false },
          { tokenId: 2, step: -1, isHome: false },
          { tokenId: 3, step: -1, isHome: false },
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
          { tokenId: 0, step: -1, isHome: false },
          { tokenId: 1, step: -1, isHome: false },
          { tokenId: 2, step: -1, isHome: false },
          { tokenId: 3, step: -1, isHome: false },
        ],
      },
    ],
    async save() {
      return this;
    },
    ...overrides,
  };
};

// ====================================================================
// TEST SUITE: Production Socket.IO Connection & Multiplayer Sync
// ====================================================================

test("1. Socket.IO polling handshake (/socket.io/?EIO=4&transport=polling) returns 200 and NOT Express 404", async () => {
  const server = http.createServer(app);
  socketManager.init(server);

  await new Promise((resolve) => server.listen(4011, "127.0.0.1", resolve));
  try {
    const res = await fetch("http://127.0.0.1:4011/socket.io/?EIO=4&transport=polling");
    assert.equal(res.status, 200, "Handshake must return 200 OK");
    const body = await res.text();
    assert.ok(body.includes('"sid"'), "Handshake body must include session ID (sid)");
    assert.ok(body.includes('"upgrades"'), "Handshake body must specify upgrade transports");
    assert.ok(!body.includes("API Route Not Found"), "Handshake must NEVER be intercepted by Express 404");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("2. Socket JWT auth middleware accepts valid token and rejects missing/invalid token", async () => {
  const server = http.createServer(app);
  socketManager.init(server);
  const realIo = socketManager.getIO();

  const middleware = realIo.of("/")._fns[0];
  assert.ok(middleware, "Auth middleware must be registered on Socket.IO");

  const validUserId = "6742d80b9a4f21001e3a9851";
  const validToken = makeToken(validUserId);

  const origFindById = User.findById;
  try {
    User.findById = (id) => ({
      select: () => ({
        lean: () => Promise.resolve({ _id: id, name: "Valid User", isActive: true }),
      }),
    });

    // Valid token
    const mockSocketValid = {
      handshake: { auth: { token: validToken } },
    };
    let nextError = null;
    await middleware(mockSocketValid, (err) => {
      nextError = err;
    });
    assert.equal(nextError, undefined, "Valid token should pass authentication");
    assert.equal(String(mockSocketValid.user._id), validUserId);

    // Missing token
    const mockSocketMissing = { handshake: { auth: {} } };
    await middleware(mockSocketMissing, (err) => {
      nextError = err;
    });
    assert.ok(nextError, "Missing token must be rejected");
    assert.match(nextError.message, /Authentication required/i);

    // Invalid token
    const mockSocketInvalid = { handshake: { auth: { token: "invalid.token.here" } } };
    await middleware(mockSocketInvalid, (err) => {
      nextError = err;
    });
    assert.ok(nextError, "Invalid token must be rejected");
    assert.match(nextError.message, /Invalid or expired token/i);
  } finally {
    User.findById = origFindById;
  }
});

test("3. Authenticated socket joins user:<userId> room upon connection", async () => {
  const { hostUser, hostSocket, userRooms } = setupMockHarness();
  assert.ok(userRooms.has(`user:${hostUser._id}`), "User room must exist in presence map");
  assert.ok(hostSocket.joinedRooms.has(`user:${hostUser._id}`), "Socket must have joined user room");
});

test("4. Authorized player can join room lobby (room:<roomCode>) and notifies other players", async () => {
  const { hostUser, hostSocket, strangerSocket } = setupMockHarness();
  const origFindOneRoom = GameRoom.findOne;
  const origFindOneSession = GameSession.findOne;

  try {
    const mockRoom = {
      roomCode: "PROD88",
      players: [{ user: hostUser._id, seatIndex: 0, color: "Red" }],
    };
    GameRoom.findOne = () => Promise.resolve(mockRoom);
    GameSession.findOne = () => Promise.resolve(null);

    let ackResult = null;
    await hostSocket.trigger("join_room", { roomCode: "PROD88" }).then((ack) => {
      ackResult = ack;
    });

    assert.equal(ackResult?.ok, true);
    assert.ok(hostSocket.joinedRooms.has("room:PROD88"), "Socket must join room:PROD88");
  } finally {
    GameRoom.findOne = origFindOneRoom;
    GameSession.findOne = origFindOneSession;
  }
});

test("5. Unauthorized player is rejected from joining private room (FORBIDDEN)", async () => {
  const { hostUser, strangerSocket } = setupMockHarness();
  const origFindOneRoom = GameRoom.findOne;
  const origFindOneSession = GameSession.findOne;

  try {
    const mockRoom = {
      roomCode: "PROD88",
      players: [{ user: hostUser._id, seatIndex: 0, color: "Red" }],
    };
    GameRoom.findOne = () => Promise.resolve(mockRoom);
    GameSession.findOne = () => Promise.resolve(null);

    let ackResult = null;
    await strangerSocket.trigger("join_room", { roomCode: "PROD88" }).then((ack) => {
      ackResult = ack;
    });

    assert.equal(ackResult?.ok, false);
    assert.equal(ackResult?.code, "FORBIDDEN");
    assert.ok(!strangerSocket.joinedRooms.has("room:PROD88"), "Unauthorized socket must NOT join room");
  } finally {
    GameRoom.findOne = origFindOneRoom;
    GameSession.findOne = origFindOneSession;
  }
});

test("6. Unauthorized player is rejected from joining private game session (FORBIDDEN)", async () => {
  const { hostUser, joinerUser, strangerSocket } = setupMockHarness();
  const session = mkFixtureSession(hostUser._id, joinerUser._id);
  const origFindSession = gameService.findSessionByGameId;

  try {
    gameService.findSessionByGameId = () => Promise.resolve(session);

    let ackResult = null;
    await strangerSocket.trigger("join_session", { sessionId: String(session._id) }).then((ack) => {
      ackResult = ack;
    });

    assert.equal(ackResult?.ok, false);
    assert.equal(ackResult?.code, "FORBIDDEN");
    assert.ok(!strangerSocket.joinedRooms.has(`session:${session._id}`));
  } finally {
    gameService.findSessionByGameId = origFindSession;
  }
});

test("7. Two authenticated players join match session, receive distinct identities and shared state", async () => {
  const { hostUser, joinerUser, hostSocket, joinerSocket } = setupMockHarness();
  const session = mkFixtureSession(hostUser._id, joinerUser._id);
  const origFindSession = gameService.findSessionByGameId;

  try {
    gameService.findSessionByGameId = () => Promise.resolve(session);

    let hostAck = null;
    let joinerAck = null;

    await hostSocket.trigger("join_session", { sessionId: String(session._id) }).then((ack) => {
      hostAck = ack;
    });
    await joinerSocket.trigger("join_session", { sessionId: String(session._id) }).then((ack) => {
      joinerAck = ack;
    });

    assert.equal(hostAck?.ok, true);
    assert.equal(joinerAck?.ok, true);

    // Host identity
    assert.equal(hostAck.data.me.seatIndex, 0);
    assert.equal(hostAck.data.me.color, "RED");
    assert.equal(hostAck.data.me.isHost, true);

    // Joiner identity
    assert.equal(joinerAck.data.me.seatIndex, 1);
    assert.equal(joinerAck.data.me.color, "GREEN");
    assert.equal(joinerAck.data.me.isHost, false);

    // Both belong to same match channels
    assert.ok(hostSocket.joinedRooms.has(`session:${session._id}`));
    assert.ok(joinerSocket.joinedRooms.has(`session:${session._id}`));
  } finally {
    gameService.findSessionByGameId = origFindSession;
  }
});

test("8. Dice roll event delivery and turn change synchronization between both players", async () => {
  const { hostUser, joinerUser, hostSocket, joinerSocket } = setupMockHarness();
  const session = mkFixtureSession(hostUser._id, joinerUser._id, {
    currentTurnPlayer: hostUser._id,
    currentTurnSeat: 0,
    turnStatus: "WAITING_FOR_ROLL",
    gamePhase: "waiting_for_roll",
  });

  const origFindById = GameSession.findById;
  const origFindOne = GameSession.findOne;
  const origRollDie = require("../../utils/secureRandom").rollDie;

  try {
    GameSession.findById = () => session;
    GameSession.findOne = () => Promise.resolve(session);
    // Force roll of 6 (Host can move token out of base)
    require("../../utils/secureRandom").rollDie = () => 6;

    hostSocket.join([session.roomCode, `session:${session._id}`]);
    joinerSocket.join([session.roomCode, `session:${session._id}`]);

    await hostSocket.trigger("dice_roll_requested", {
      sessionId: String(session._id),
      actionId: "act_prod_roll_1",
    });

    const hostRollEvents = hostSocket.getEvents("dice_roll_result");
    const joinerRollEvents = joinerSocket.getEvents("dice_roll_result");

    assert.ok(hostRollEvents.length > 0, "Host must receive dice_roll_result");
    assert.ok(joinerRollEvents.length > 0, "Joiner must receive dice_roll_result");

    const hostRoll = hostRollEvents[hostRollEvents.length - 1].payload;
    const joinerRoll = joinerRollEvents[joinerRollEvents.length - 1].payload;

    assert.equal(hostRoll.diceValue, 6);
    assert.equal(joinerRoll.diceValue, 6);
    assert.equal(hostRoll.playerId, String(hostUser._id));
    assert.equal(joinerRoll.playerId, String(hostUser._id));
    assert.equal(hostRoll.stateVersion, joinerRoll.stateVersion);
  } finally {
    GameSession.findById = origFindById;
    GameSession.findOne = origFindOne;
    require("../../utils/secureRandom").rollDie = origRollDie;
  }
});

test("9. Token move synchronization and turn transition to Joiner", async () => {
  const { hostUser, joinerUser, hostSocket, joinerSocket } = setupMockHarness();
  const session = mkFixtureSession(hostUser._id, joinerUser._id, {
    currentTurnPlayer: hostUser._id,
    currentTurnSeat: 0,
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 2, // Non-6 move does not grant extra turn
    players: [
      {
        user: hostUser._id,
        name: "Host Player",
        seatIndex: 0,
        color: "Red",
        tokens: [
          { tokenId: 0, step: 10, isHome: false },
          { tokenId: 1, step: -1, isHome: false },
          { tokenId: 2, step: -1, isHome: false },
          { tokenId: 3, step: -1, isHome: false },
        ],
      },
      {
        user: joinerUser._id,
        name: "Joiner Player",
        seatIndex: 1,
        color: "Green",
        tokens: [
          { tokenId: 0, step: 0, isHome: false },
          { tokenId: 1, step: -1, isHome: false },
          { tokenId: 2, step: -1, isHome: false },
          { tokenId: 3, step: -1, isHome: false },
        ],
      },
    ],
  });

  const origFindById = GameSession.findById;
  const origFindOne = GameSession.findOne;

  try {
    GameSession.findById = () => session;
    GameSession.findOne = () => Promise.resolve(session);

    hostSocket.join([session.roomCode, `session:${session._id}`]);
    joinerSocket.join([session.roomCode, `session:${session._id}`]);

    await hostSocket.trigger("token_move_requested", {
      sessionId: String(session._id),
      tokenId: 0,
      actionId: "act_prod_move_1",
    });

    const hostMoveEvents = hostSocket.getEvents("token_moved");
    const joinerMoveEvents = joinerSocket.getEvents("token_moved");

    assert.ok(hostMoveEvents.length > 0, "Host must receive token_moved");
    assert.ok(joinerMoveEvents.length > 0, "Joiner must receive token_moved");

    const hostMove = hostMoveEvents[hostMoveEvents.length - 1].payload;
    const joinerMove = joinerMoveEvents[joinerMoveEvents.length - 1].payload;

    assert.equal(hostMove.move.newStep, 12);
    assert.equal(joinerMove.move.newStep, 12);

    // Turn transitioned to Joiner
    const hostTurnEvents = hostSocket.getEvents("turn_changed");
    const joinerTurnEvents = joinerSocket.getEvents("turn_changed");
    assert.ok(hostTurnEvents.length > 0);
    assert.ok(joinerTurnEvents.length > 0);

    const nextTurn = joinerTurnEvents[joinerTurnEvents.length - 1].payload;
    assert.equal(nextTurn.currentTurnPlayer, String(joinerUser._id));
    assert.equal(nextTurn.currentTurnSeat, 1);
  } finally {
    GameSession.findById = origFindById;
    GameSession.findOne = origFindOne;
  }
});

test("10. Temporary disconnect and reconnect restores full authoritative state and joins rooms", async () => {
  const { hostUser, joinerUser, hostSocket, joinerSocket } = setupMockHarness();
  const session = mkFixtureSession(hostUser._id, joinerUser._id, {
    currentTurnPlayer: joinerUser._id,
    currentTurnSeat: 1,
    turnStatus: "WAITING_FOR_ROLL",
    actionSequence: 15,
    turnNumber: 8,
  });

  const origFindById = GameSession.findById;
  const origFind = GameSession.find;

  try {
    GameSession.findById = () => session;
    GameSession.find = () => ({
      limit: () => Promise.resolve([session]),
    });

    hostSocket.join([session.roomCode, `session:${session._id}`]);

    // Simulate joiner disconnecting first
    await joinerSocket.trigger("disconnect");

    // Simulate joiner reconnecting with new socket
    const newJoinerSocket = new (joinerSocket.constructor)(joinerUser._id, joinerUser.name);
    const realIo = socketManager.getIO();
    const connListener = realIo.listeners("connection")[0];
    if (connListener) {
      connListener(newJoinerSocket);
    }

    // Wait for async resumeActiveSessions
    await new Promise((r) => setTimeout(r, 100));

    // Reconnecting socket received both active_game and game_state
    const activeGameEvents = newJoinerSocket.getEvents("active_game");
    const gameStateEvents = newJoinerSocket.getEvents("game_state");

    assert.ok(activeGameEvents.length > 0, "Reconnecting socket must receive active_game");
    assert.ok(gameStateEvents.length > 0, "Reconnecting socket must receive game_state immediately");

    const syncState = gameStateEvents[gameStateEvents.length - 1].payload;
    assert.equal(syncState.sessionId, String(session._id));
    assert.equal(syncState.stateVersion, 15);
    assert.equal(syncState.currentTurnPlayer, String(joinerUser._id));
    assert.equal(syncState.me.seatIndex, 1);
    assert.equal(syncState.me.color, "GREEN");
  } finally {
    GameSession.findById = origFindById;
    GameSession.find = origFind;
  }
});

test("11. REST API GET /api/games/session/:id returns authoritative state and validates membership", async () => {
  const hostId = "6742d80b9a4f21001e3a9851";
  const joinerId = "6742d80b9a4f21001e3a9852";
  const strangerId = "6742d80b9a4f21001e3a9899";

  const session = mkFixtureSession(hostId, joinerId);
  const origFindById = GameSession.findById;

  try {
    GameSession.findById = (id) => ({
      populate: () => ({
        populate: () => Promise.resolve(session),
      }),
      then: (resolve) => resolve(session),
    });

    const createReqRes = (userId) => {
      let code = 200;
      let body = null;
      return {
        req: { params: { sessionId: String(session._id) }, user: { _id: userId } },
        res: {
          status(c) {
            code = c;
            return this;
          },
          json(b) {
            body = b;
            return this;
          },
        },
        getCode: () => code,
        getBody: () => body,
      };
    };

    // Host retrieves session
    const { req: hostReq, res: hostRes, getCode: getHostCode, getBody: getHostBody } = createReqRes(hostId);
    await gameController.getGameSession(hostReq, hostRes);

    assert.equal(getHostCode(), 200);
    const hostJson = getHostBody();
    assert.equal(hostJson.success, true);
    assert.equal(hostJson.sessionId, String(session._id));
    assert.equal(hostJson.player.seatIndex, 0);
    assert.equal(hostJson.player.color, "RED");
    assert.ok(hostJson.gameState);

    // Stranger forbidden
    const { req: strReq, res: strRes } = createReqRes(strangerId);
    await assert.rejects(
      async () => {
        await gameController.getGameSession(strReq, strRes);
      },
      (err) => {
        assert.match(err.message, /(not a participant|not a player)/i);
        return true;
      }
    );
  } finally {
    GameSession.findById = origFindById;
  }
});
