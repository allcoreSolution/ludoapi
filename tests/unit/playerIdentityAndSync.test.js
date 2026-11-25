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
const gameController = require("../../src/modules/games/controllers/game.controller");
const matchmakingService = require("../../src/modules/matchmaking/services/matchmaking.service");
const matchmakingController = require("../../src/modules/matchmaking/controllers/matchmaking.controller");
const walletService = require("../../src/modules/wallet/services/wallet.service");
const socketManager = require("../../src/sockets/socketManager");

// Mock Socket.IO Harness for per-user / per-socket dispatch
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

  return { hostUser, joinerUser, hostSocket, joinerSocket, userRooms, groupRooms };
};

// Fixture builder for 2-player session
const mkFixtureSession = (hostId, joinerId, overrides = {}) => {
  return {
    _id: "6742db5e9a4f21001e3a9899",
    room: "6742db5e9a4f21001e3a9898",
    roomCode: "SYNC88",
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
};

// -----------------------------------------------------------------------------
// 10 MANDATORY PLAYER IDENTITY & MULTIPLAYER SYNCHRONIZATION TESTS
// -----------------------------------------------------------------------------

test("1. Host receives Seat 0 / RED on Room Create (REST & Model)", async () => {
  const hostUser = { _id: "6742d80b9a4f21001e3a9851", name: "Host Player" };

  walletService.getBalance = async () => 1000;
  GameRoom.findOne = async () => null;
  GameRoom.create = async (doc) => ({
    _id: "room_111",
    ...doc,
  });

  const req = { user: hostUser, body: { maxPlayers: 2, gameMode: "twoPlayer", entryFee: 0 } };
  let responseStatus = null;
  let responseData = null;
  const res = {
    status(code) {
      responseStatus = code;
      return this;
    },
    json(body) {
      responseData = body;
      return this;
    },
  };

  await roomController.createRoom(req, res);

  assert.equal(responseStatus, 201);
  assert.equal(responseData.success, true);
  assert.ok(responseData.player, "player object exists in response root");
  assert.equal(responseData.player.userId, hostUser._id);
  assert.equal(responseData.player.seatIndex, 0);
  assert.equal(responseData.player.color, "RED");
  assert.equal(responseData.player.isHost, true);

  // Check data payload parity
  assert.equal(responseData.data.player.seatIndex, 0);
  assert.equal(responseData.data.player.color, "RED");
  assert.equal(responseData.data.player.isHost, true);
});

test("2. Joiner receives Seat 1 / GREEN on Room Join (REST & Model)", async () => {
  const hostUser = { _id: "6742d80b9a4f21001e3a9851", name: "Host Player" };
  const joinerUser = { _id: "6742d80b9a4f21001e3a9852", name: "Joiner Player" };

  const existingRoom = {
    _id: "room_111",
    roomCode: "TEST88",
    host: hostUser._id,
    maxPlayers: 2,
    status: "waiting",
    entryFee: 0,
    players: [
      { user: hostUser._id, name: hostUser.name, seatIndex: 0, color: "Red", isHost: true },
    ],
  };

  const updatedRoom = {
    ...existingRoom,
    players: [
      ...existingRoom.players,
      { user: joinerUser._id, name: joinerUser.name, seatIndex: 1, color: "Green", isHost: false },
    ],
  };

  walletService.getBalance = async () => 1000;
  GameRoom.findOne = async (q) => {
    if (q && q.roomCode) return existingRoom;
    return null;
  };
  GameRoom.findOneAndUpdate = async () => updatedRoom;
  GameSession.findOne = async () => null;

  const req = { user: joinerUser, body: { roomCode: "TEST88" } };
  let responseStatus = null;
  let responseData = null;
  const res = {
    status(code) {
      responseStatus = code;
      return this;
    },
    json(body) {
      responseData = body;
      return this;
    },
  };

  await roomController.joinRoom(req, res);

  assert.equal(responseStatus, 200);
  assert.equal(responseData.success, true);
  assert.ok(responseData.player, "player object exists in response root");
  assert.equal(responseData.player.userId, joinerUser._id);
  assert.equal(responseData.player.seatIndex, 1);
  assert.equal(responseData.player.color, "GREEN");
  assert.equal(responseData.player.isHost, false);

  assert.equal(responseData.data.player.seatIndex, 1);
  assert.equal(responseData.data.player.color, "GREEN");
  assert.equal(responseData.data.player.isHost, false);
});

test("3. Different users receive different identities (Host != Joiner)", async () => {
  const hostId = "6742d80b9a4f21001e3a9851";
  const joinerId = "6742d80b9a4f21001e3a9852";

  const session = mkFixtureSession(hostId, joinerId);
  const hostPlayer = session.players.find((p) => String(p.user) === hostId);
  const joinerPlayer = session.players.find((p) => String(p.user) === joinerId);

  assert.notEqual(String(hostPlayer.user), String(joinerPlayer.user));
  assert.notEqual(hostPlayer.seatIndex, joinerPlayer.seatIndex);
  assert.notEqual(hostPlayer.color.toUpperCase(), joinerPlayer.color.toUpperCase());
  assert.equal(hostPlayer.isHost, true);
  assert.equal(joinerPlayer.isHost, false);
});

test("4. Same user cannot occupy two seats in the same room/match", async () => {
  const hostUser = { _id: "6742d80b9a4f21001e3a9851", name: "Host Player" };

  const existingRoom = {
    _id: "room_111",
    roomCode: "TEST88",
    host: hostUser._id,
    maxPlayers: 2,
    status: "waiting",
    entryFee: 0,
    players: [
      { user: hostUser._id, name: hostUser.name, seatIndex: 0, color: "Red", isHost: true },
    ],
  };

  GameRoom.findOne = async () => existingRoom;

  // Host tries to join their own room again as second player
  const result = await roomService.joinRoom(hostUser, "TEST88");

  assert.equal(result.alreadyInRoom, true);
  assert.equal(result.room.players.length, 1); // Only 1 seat occupied
});

test("5. Each socket receives its own 'me' object on game start (never opponent's)", async () => {
  const { hostUser, joinerUser, hostSocket, joinerSocket } = setupMockHarness();
  const session = mkFixtureSession(hostUser._id, joinerUser._id);

  hostSocket.clearEvents();
  joinerSocket.clearEvents();

  // Call the authoritative per-player broadcaster
  socketManager.broadcastGameStartedToPlayers(session, session.roomCode);

  const hostStart = hostSocket.getLastEvent("game_started");
  const joinerStart = joinerSocket.getLastEvent("game_started");

  assert.ok(hostStart, "Host socket received game_started");
  assert.ok(joinerStart, "Joiner socket received game_started");

  // Host received me: Seat 0, RED, isHost: true
  assert.equal(hostStart.payload.me.userId, hostUser._id);
  assert.equal(hostStart.payload.me.seatIndex, 0);
  assert.equal(hostStart.payload.me.color, "RED");
  assert.equal(hostStart.payload.me.isHost, true);

  // Joiner received me: Seat 1, GREEN, isHost: false
  assert.equal(joinerStart.payload.me.userId, joinerUser._id);
  assert.equal(joinerStart.payload.me.seatIndex, 1);
  assert.equal(joinerStart.payload.me.color, "GREEN");
  assert.equal(joinerStart.payload.me.isHost, false);

  // CRITICAL CHECK: Host's socket DID NOT receive Joiner's me, and vice-versa
  assert.notEqual(hostStart.payload.me.userId, joinerStart.payload.me.userId);
  assert.notEqual(hostStart.payload.me.color, joinerStart.payload.me.color);
  assert.notEqual(hostStart.payload.me.seatIndex, joinerStart.payload.me.seatIndex);
});

test("6. Host reconnects without seat change and receives original identity", async () => {
  const hostId = "6742d80b9a4f21001e3a9851";
  const joinerId = "6742d80b9a4f21001e3a9852";
  const session = mkFixtureSession(hostId, joinerId);

  GameSession.findById = () => ({
    ...session,
    populate: () => ({
      populate: async () => session,
    }),
  });

  const req = { user: { _id: hostId }, params: { sessionId: session._id } };
  let responseData = null;
  const res = {
    status() {
      return this;
    },
    json(body) {
      responseData = body;
      return this;
    },
  };

  await gameController.getGameSession(req, res);

  assert.equal(responseData.success, true);
  assert.equal(responseData.player.userId, hostId);
  assert.equal(responseData.player.seatIndex, 0);
  assert.equal(responseData.player.color, "RED");
  assert.equal(responseData.player.isHost, true);
});

test("7. Joiner reconnects without seat change and receives original identity", async () => {
  const hostId = "6742d80b9a4f21001e3a9851";
  const joinerId = "6742d80b9a4f21001e3a9852";
  const session = mkFixtureSession(hostId, joinerId);

  GameSession.findById = () => ({
    ...session,
    populate: () => ({
      populate: async () => session,
    }),
  });

  const req = { user: { _id: joinerId }, params: { sessionId: session._id } };
  let responseData = null;
  const res = {
    status() {
      return this;
    },
    json(body) {
      responseData = body;
      return this;
    },
  };

  await gameController.getGameSession(req, res);

  assert.equal(responseData.success, true);
  assert.equal(responseData.player.userId, joinerId);
  assert.equal(responseData.player.seatIndex, 1);
  assert.equal(responseData.player.color, "GREEN");
  assert.equal(responseData.player.isHost, false);
});

test("8. Only correct player can roll dice (Player A can roll, Player B rejected with OUT_OF_TURN)", async () => {
  const hostId = "6742d80b9a4f21001e3a9851";
  const joinerId = "6742d80b9a4f21001e3a9852";
  const session = mkFixtureSession(hostId, joinerId, {
    currentTurnPlayer: hostId,
    currentTurnSeat: 0,
    turnStatus: "WAITING_FOR_ROLL",
    gamePhase: "waiting_for_roll",
  });

  GameSession.findById = async () => session;

  // Player B tries to roll during Player A's turn
  await assert.rejects(
    async () => {
      await gameService.rollDice(joinerId, session._id);
    },
    (err) => {
      assert.match(err.message, /not your turn/i);
      return true;
    }
  );

  // Player A rolls during Player A's turn -> succeeds
  const res = await gameService.rollDice(hostId, session._id);
  assert.ok(res.data.diceValue >= 1 && res.data.diceValue <= 6);
});

test("9. Only correct player can move their tokens (token ownership & turn validated)", async () => {
  const hostId = "6742d80b9a4f21001e3a9851";
  const joinerId = "6742d80b9a4f21001e3a9852";
  const session = mkFixtureSession(hostId, joinerId, {
    currentTurnPlayer: hostId,
    currentTurnSeat: 0,
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 6, // 6 allows token 0 to move out of base
  });

  GameSession.findById = async () => session;

  // Player B tries to move a token during Player A's turn -> rejected
  await assert.rejects(
    async () => {
      await gameService.moveToken(joinerId, session._id, 0);
    },
    (err) => {
      assert.match(err.message, /not your turn/i);
      return true;
    }
  );

  // Player A moves their token -> succeeds
  const moveRes = await gameService.moveToken(hostId, session._id, 0);
  assert.ok(moveRes.data.move);
  assert.equal(moveRes.data.move.tokenId, 0);
});

test("10. Both players receive synchronized game states with identical version and token positions", async () => {
  const hostId = "6742d80b9a4f21001e3a9851";
  const joinerId = "6742d80b9a4f21001e3a9852";
  const session = mkFixtureSession(hostId, joinerId, {
    actionSequence: 5,
    turnNumber: 3,
  });

  const baseState = socketManager.formatSessionState(session);
  const hostView = socketManager.viewerView(baseState, hostId);
  const joinerView = socketManager.viewerView(baseState, joinerId);

  // Global authoritative game state matches
  assert.equal(hostView.stateVersion, joinerView.stateVersion);
  assert.equal(hostView.turnNumber, joinerView.turnNumber);
  assert.equal(hostView.currentPlayerId, joinerView.currentPlayerId);
  assert.deepEqual(hostView.tokens, joinerView.tokens);

  // Individual viewer perspectives differ accurately
  assert.equal(hostView.me.userId, hostId);
  assert.equal(hostView.me.seatIndex, 0);
  assert.equal(hostView.me.color, "RED");

  assert.equal(joinerView.me.userId, joinerId);
  assert.equal(joinerView.me.seatIndex, 1);
  assert.equal(joinerView.me.color, "GREEN");
});
