"use strict";
process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const jwt = require("jsonwebtoken");

const config = require("../../config/env");
const app = require("../../app");
const socketManager = require("../../src/sockets/socketManager");
const GameSession = require("../../src/modules/games/models/GameSession");
const MatchmakingQueue = require("../../src/modules/matchmaking/models/MatchmakingQueue");
const Admin = require("../../src/modules/admin/models/admin.model");
const User = require("../../src/modules/auth/models/User");

let server;
let port;
let baseUrl;

const signAdmin = (adminId, opts = {}) =>
  jwt.sign({ id: String(adminId), typ: "admin" }, config.jwt.secret, {
    algorithm: "HS256",
    issuer: config.jwt.issuer,
    expiresIn: "1h",
    ...opts,
  });

const signPlayer = (userId, opts = {}) =>
  jwt.sign({ id: String(userId) }, config.jwt.secret, {
    algorithm: "HS256",
    issuer: config.jwt.issuer,
    expiresIn: "1h",
    ...opts,
  });

test.before(async () => {
  server = http.createServer(app);
  socketManager.init(server);
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await socketManager.close();
  await new Promise((resolve) => server.close(resolve));
});

const callApi = (method, path, { token, body } = {}) =>
  fetch(baseUrl + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

test("ADMIN ONLINE APIS: Auth & Validation Protection", async () => {
  const origFindAdmin = Admin.findById;
  Admin.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: "64b000000000000000000001",
        name: "Super Admin",
        role: "superadmin",
        isActive: true,
      }),
    }),
  });

  try {
    // 1. Missing Token => 401
    const resNoAuth = await callApi("GET", "/api/admin/online/live-matches");
    assert.equal(resNoAuth.status, 401);

    // 2. Normal Player Token => 401 (typ is not admin)
    const playerToken = signPlayer("64b000000000000000000099");
    const resPlayerAuth = await callApi("GET", "/api/admin/online/live-matches", { token: playerToken });
    assert.equal(resPlayerAuth.status, 401);

    // 3. Invalid Session ID param validation => 400
    const adminToken = signAdmin("64b000000000000000000001");
    const resBadId = await callApi("GET", "/api/admin/online/live-matches/bad!id@chars", { token: adminToken });
    assert.equal(resBadId.status, 400);

    // 4. Invalid mode filter query validation => 400
    const resBadMode = await callApi("GET", "/api/admin/online/live-matches?mode=invalidMode", { token: adminToken });
    assert.equal(resBadMode.status, 400);
  } finally {
    Admin.findById = origFindAdmin;
  }
});

test("ADMIN ONLINE APIS: GET /api/admin/online/live-matches (mocked DB response)", async () => {
  const origFind = GameSession.find;
  const origCount = GameSession.countDocuments;
  const origFindAdmin = Admin.findById;

  const mockSessionId = "64b000000000000000000101";
  const mockPlayer1Id = "64b000000000000000000201";
  const mockPlayer2Id = "64b000000000000000000202";

  Admin.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: "64b000000000000000000001",
        name: "Super Admin",
        role: "superadmin",
        isActive: true,
      }),
    }),
  });

  const fakeSession = {
    _id: mockSessionId,
    roomCode: "LUDO99",
    gameMode: "twoPlayer",
    status: "in_progress",
    entryFee: 50,
    prizePool: 90,
    startedAt: new Date(Date.now() - 45000),
    createdAt: new Date(Date.now() - 50000),
    currentTurnPlayer: mockPlayer1Id,
    currentTurnSeat: 0,
    turnStatus: "WAITING_FOR_ROLL",
    gamePhase: "waiting_for_roll",
    turnDeadline: new Date(Date.now() + 10000),
    lastDiceValue: 6,
    players: [
      {
        user: { _id: mockPlayer1Id },
        name: "Rahul",
        avatar: "avatar1.png",
        seatIndex: 0,
        color: "Red",
        score: 120,
      },
      {
        user: { _id: mockPlayer2Id },
        name: "Amit",
        avatar: "avatar2.png",
        seatIndex: 1,
        color: "Green",
        score: 80,
      },
    ],
  };

  GameSession.countDocuments = async () => 1;
  GameSession.find = () => ({
    sort: () => ({
      skip: () => ({
        limit: () => ({
          select: () => ({
            lean: async () => [fakeSession],
          }),
        }),
      }),
    }),
  });

  try {
    const adminToken = signAdmin("64b000000000000000000001");
    const res = await callApi("GET", "/api/admin/online/live-matches", { token: adminToken });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(Array.isArray(body.data.matches), true);
    assert.equal(body.data.matches.length, 1);

    const m = body.data.matches[0];
    assert.equal(m.sessionId, mockSessionId);
    assert.equal(m.roomCode, "LUDO99");
    assert.equal(m.mode, "twoPlayer");
    assert.equal(m.status, "in_progress");
    assert.equal(m.entryFee, 50);
    assert.equal(m.prizePool, 90);
    assert.ok(m.elapsedSeconds >= 40);
    assert.equal(m.diceValue, 6);
    assert.equal(m.currentTurn.playerId, mockPlayer1Id);
    assert.equal(m.players.length, 2);
    assert.equal(m.players[0].displayName, "Rahul");
    assert.equal(m.players[0].connectionStatus, "offline");
    assert.equal(m.players[0].socketConnected, false);
    assert.equal(m.players[0].lastSeenAt, null);
    assert.equal(body.data.pagination.total, 1);
  } finally {
    GameSession.find = origFind;
    GameSession.countDocuments = origCount;
    Admin.findById = origFindAdmin;
  }
});

test("ADMIN ONLINE APIS: GET /api/admin/online/live-matches/:sessionId (detailed snapshot)", async () => {
  const origFindOne = GameSession.findOne;
  const origFindAdmin = Admin.findById;

  const mockSessionId = "64b000000000000000000101";
  const mockPlayer1Id = "64b000000000000000000201";

  Admin.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: "64b000000000000000000001",
        name: "Super Admin",
        role: "superadmin",
        isActive: true,
      }),
    }),
  });

  const detailedSession = {
    _id: mockSessionId,
    roomCode: "LUDO99",
    gameMode: "twoPlayer",
    status: "in_progress",
    entryFee: 50,
    prizePool: 90,
    startedAt: new Date(Date.now() - 60000),
    createdAt: new Date(Date.now() - 70000),
    updatedAt: new Date(),
    turnNumber: 4,
    actionSequence: 7,
    currentTurnPlayer: mockPlayer1Id,
    currentTurnSeat: 0,
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 5,
    consecutiveSixes: 0,
    turnDeadline: new Date(Date.now() + 8000),
    players: [
      {
        user: { _id: mockPlayer1Id },
        name: "Rahul",
        seatIndex: 0,
        color: "Red",
        score: 100,
        hasSurrendered: false,
        tokens: [
          { tokenId: 0, step: 12, isHome: false },
          { tokenId: 1, step: -1, isHome: false },
          { tokenId: 2, step: -1, isHome: false },
          { tokenId: 3, step: -1, isHome: false },
        ],
      },
    ],
    history: [
      {
        player: mockPlayer1Id,
        action: "ROLL",
        diceValue: 5,
        pointsEarned: 0,
        timestamp: new Date(),
      },
    ],
  };

  GameSession.findOne = (q) => ({
    lean: async () => {
      if (q._id === mockSessionId || q.roomCode === "LUDO99") {
        return detailedSession;
      }
      return null;
    },
  });

  try {
    const adminToken = signAdmin("64b000000000000000000001");

    // 1. By sessionId
    const res = await callApi("GET", `/api/admin/online/live-matches/${mockSessionId}`, { token: adminToken });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.match.sessionId, mockSessionId);
    assert.equal(body.data.match.diceState.lastDiceValue, 5);
    assert.ok(body.data.match.currentTurnRemainingTime.remainingSeconds >= 1);
    assert.equal(body.data.match.players[0].tokens[0].step, 12);
    assert.equal(body.data.match.moveHistory[0].action, "ROLL");
    assert.equal(body.data.match.moveHistory[0].player, "Rahul");

    // 2. Not found
    const resNotFound = await callApi("GET", "/api/admin/online/live-matches/64b000000000000000000999", { token: adminToken });
    assert.equal(resNotFound.status, 404);
  } finally {
    GameSession.findOne = origFindOne;
    Admin.findById = origFindAdmin;
  }
});

test("ADMIN ONLINE APIS: GET /api/admin/online/queues", async () => {
  const origFindQueue = MatchmakingQueue.find;
  const origFindAdmin = Admin.findById;

  Admin.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: "64b000000000000000000001",
        name: "Super Admin",
        role: "superadmin",
        isActive: true,
      }),
    }),
  });

  MatchmakingQueue.find = () => ({
    select: () => ({
      lean: async () => [
        {
          gameMode: "twoPlayer",
          queueType: "standard",
          createdAt: new Date(Date.now() - 30000),
        },
        {
          gameMode: "twoPlayer",
          queueType: "standard",
          createdAt: new Date(Date.now() - 10000),
        },
        {
          gameMode: "threePlayer",
          queueType: "nearby",
          createdAt: new Date(Date.now() - 25000),
        },
      ],
    }),
  });

  try {
    const adminToken = signAdmin("64b000000000000000000001");
    const res = await callApi("GET", "/api/admin/online/queues", { token: adminToken });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.totalQueued, 3);

    const modes = body.data.modes;
    const twoP = modes.find((m) => m.mode === "twoPlayer");
    assert.equal(twoP.queueCount, 2);
    assert.ok(twoP.oldestWaitingSeconds >= 29);
    assert.ok(twoP.averageWaitingSeconds >= 19 && twoP.averageWaitingSeconds <= 25);
    assert.equal(twoP.byQueueType.standard, 2);

    const threeP = modes.find((m) => m.mode === "threePlayer");
    assert.equal(threeP.queueCount, 1);
    assert.equal(threeP.byQueueType.nearby, 1);

    const fourP = modes.find((m) => m.mode === "fourPlayer");
    assert.equal(fourP.queueCount, 0);
  } finally {
    MatchmakingQueue.find = origFindQueue;
    Admin.findById = origFindAdmin;
  }
});

test("ADMIN SOCKET TELEMETRY: Admin Auth & admin_telemetry Room Security", async () => {
  const origFindAdmin = Admin.findById;
  const origFindUser = User.findById;

  Admin.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: "64b000000000000000000001",
        name: "Super Admin",
        email: "admin@ludo.com",
        role: "superadmin",
        isActive: true,
      }),
    }),
  });

  User.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: "64b000000000000000000088",
        name: "Test Player",
        username: "testplayer",
        avatar: "",
        isActive: true,
        role: "user",
      }),
    }),
  });

  try {
    const realIo = socketManager.getIO();
    assert.ok(realIo);
    const nsp = realIo.of("/");
    const fns = nsp._fns || [];

    // Mock socket implementation for unit testing socketManager handlers
    class MockSocket {
      constructor(token) {
        this.id = `sock_${Math.random().toString(36).slice(2, 7)}`;
        this.handshake = { auth: { token }, headers: {}, query: {} };
        this.rooms = new Set([this.id]);
        this.handlers = new Map();
        this.emittedEvents = [];
      }
      join(room) {
        if (Array.isArray(room)) room.forEach((r) => this.rooms.add(r));
        else this.rooms.add(room);
      }
      leave(room) {
        this.rooms.delete(room);
      }
      on(event, handler) {
        this.handlers.set(event, handler);
      }
      emit(event, payload) {
        this.emittedEvents.push({ event, payload });
      }
      async trigger(event, data) {
        const handler = this.handlers.get(event);
        if (!handler) return undefined;
        return new Promise((resolve) => {
          handler(data, (ack) => resolve(ack));
        });
      }
    }

    const adminToken = signAdmin("64b000000000000000000001");
    const playerToken = signPlayer("64b000000000000000000088");

    // 1. Test Admin Auth Middleware
    const adminSock = new MockSocket(adminToken);
    let adminAuthErr;
    for (const mw of fns) {
      await mw(adminSock, (err) => { adminAuthErr = err; });
    }
    assert.equal(adminAuthErr, undefined);
    assert.equal(adminSock.isAdmin, true);

    // Trigger connection listener for admin socket
    const connListeners = realIo.listeners("connection");
    assert.ok(connListeners.length > 0);
    connListeners[0](adminSock);

    // Admin calls join_admin_telemetry => Allowed
    const adminJoinAck = await adminSock.trigger("join_admin_telemetry", {});
    assert.equal(adminJoinAck.ok, true);
    assert.ok(adminSock.rooms.has("admin_telemetry"));

    // 2. Test Player Auth Middleware
    const playerSock = new MockSocket(playerToken);
    let playerAuthErr;
    for (const mw of fns) {
      await mw(playerSock, (err) => { playerAuthErr = err; });
    }
    assert.equal(playerAuthErr, undefined);
    assert.equal(playerSock.isAdmin, false);

    // Trigger connection listener for player socket
    connListeners[0](playerSock);

    // Normal player calls join_admin_telemetry => Must be FORBIDDEN
    const playerJoinAck = await playerSock.trigger("join_admin_telemetry", {});
    assert.equal(playerJoinAck.ok, false);
    assert.equal(playerJoinAck.code, "FORBIDDEN");
    assert.equal(playerSock.rooms.has("admin_telemetry"), false);

    // 3. Test emitAdminTelemetry helper
    const telemetryResult = socketManager.emitAdminTelemetry("admin_live_match_created", {
      sessionId: "64b000000000000000000101",
      roomCode: "LUDO99",
      mode: "twoPlayer",
      timestamp: new Date(),
    });
    assert.equal(telemetryResult, true);
  } finally {
    Admin.findById = origFindAdmin;
    User.findById = origFindUser;
  }
});
