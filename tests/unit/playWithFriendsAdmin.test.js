"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const jwt = require("jsonwebtoken");

const config = require("../../config/env");
const app = require("../../app");
const GameRoom = require("../../src/modules/rooms/models/GameRoom");
const Admin = require("../../src/modules/admin/models/admin.model");
const AdminAuditLog = require("../../src/modules/admin/models/adminAuditLog.model");
const roomService = require("../../src/modules/rooms/services/room.service");

let server;
let baseUrl;

const signAdmin = (adminId, opts = {}) =>
  jwt.sign({ id: String(adminId), typ: "admin" }, config.jwt.secret, {
    algorithm: "HS256",
    issuer: config.jwt.issuer,
    expiresIn: "1h",
    ...opts,
  });

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
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

const makeChain = (val) => {
  const chain = {
    sort: () => chain,
    skip: () => chain,
    limit: () => chain,
    select: () => chain,
    populate: () => chain,
    slice: () => chain,
    lean: () => Promise.resolve(val),
    then: (resolve, reject) => Promise.resolve(val).then(resolve, reject),
  };
  return chain;
};

// -------------------------------------------------------------
// 1. Room Invitation Availability Check (Enhanced Fields)
// -------------------------------------------------------------
test("PLAY WITH FRIENDS: Room availability check returns expiry and host details", async () => {
  const origFindOne = GameRoom.findOne;
  const mockCode = "TEST99";
  const futureExpiry = new Date(Date.now() + 600000);

  const mockDoc = {
    _id: "64b000000000000000000010",
    roomCode: mockCode,
    host: {
      _id: "64b000000000000000000001",
      name: "Host Alice",
      username: "alice",
      avatar: "avatar1.png",
    },
    players: [
      {
        user: "64b000000000000000000001",
        name: "Host Alice",
        color: "Red",
        seatIndex: 0,
        isHost: true,
      },
    ],
    maxPlayers: 2,
    gameMode: "twoPlayer",
    entryFee: 50,
    prizePool: 90,
    status: "waiting",
    expiresAt: futureExpiry,
    createdAt: new Date(),
  };

  GameRoom.findOne = () => makeChain(mockDoc);

  try {
    const res = await callApi("GET", `/api/rooms/${mockCode}/check`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.roomExists, true);
    assert.equal(body.canJoin, true);
    assert.equal(body.isJoinable, true);
    assert.equal(body.roomCode, mockCode);
    assert.equal(body.host.name, "Host Alice");
    assert.ok(body.expiresAt);
    assert.ok(body.remainingSeconds > 0);
  } finally {
    GameRoom.findOne = origFindOne;
  }
});

test("PLAY WITH FRIENDS: Room check recognizes expired room", async () => {
  const origFindOne = GameRoom.findOne;
  const mockCode = "EXPD01";
  const pastExpiry = new Date(Date.now() - 60000);

  const mockDoc = {
    _id: "64b000000000000000000011",
    roomCode: mockCode,
    host: { _id: "64b000000000000000000001", name: "Host Bob" },
    players: [{ user: "64b000000000000000000001", name: "Host Bob", seatIndex: 0 }],
    maxPlayers: 2,
    gameMode: "twoPlayer",
    entryFee: 100,
    status: "waiting",
    expiresAt: pastExpiry,
  };

  GameRoom.findOne = () => makeChain(mockDoc);

  try {
    const res = await callApi("GET", `/api/rooms/${mockCode}/check`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.canJoin, false);
    assert.equal(body.errorCode, "ROOM_EXPIRED");
  } finally {
    GameRoom.findOne = origFindOne;
  }
});

// -------------------------------------------------------------
// 2. Admin Room APIs: List, Detail, Cancel, Expire
// -------------------------------------------------------------
test("ADMIN ROOMS: List rooms and detail", async () => {
  const origFindAdmin = Admin.findById;
  const origFind = GameRoom.find;
  const origCount = GameRoom.countDocuments;
  const origFindOne = GameRoom.findOne;

  Admin.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: "64b000000000000000000001",
        name: "Admin User",
        role: "admin",
        isActive: true,
      }),
    }),
  });

  const mockRoom = {
    _id: "64b000000000000000000020",
    roomCode: "ADMR01",
    host: { _id: "64b000000000000000000001", name: "Alice", email: "alice@example.com" },
    players: [
      { user: { _id: "64b000000000000000000001", name: "Alice" }, seatIndex: 0, color: "Red" },
    ],
    maxPlayers: 2,
    gameMode: "twoPlayer",
    entryFee: 100,
    prizePool: 180,
    status: "waiting",
    expiresAt: new Date(Date.now() + 500000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  GameRoom.find = () => makeChain([mockRoom]);
  GameRoom.countDocuments = () => Promise.resolve(1);
  GameRoom.findOne = () => makeChain(mockRoom);

  const token = signAdmin("64b000000000000000000001");

  try {
    // 1. GET /api/admin/rooms
    const resList = await callApi("GET", "/api/admin/rooms", { token });
    assert.equal(resList.status, 200);
    const bodyList = await resList.json();
    assert.equal(bodyList.success, true);
    assert.equal(bodyList.data.rooms.length, 1);
    assert.equal(bodyList.data.rooms[0].roomCode, "ADMR01");

    // 2. GET /api/admin/rooms/:id
    const resDetail = await callApi("GET", `/api/admin/rooms/${mockRoom._id}`, { token });
    assert.equal(resDetail.status, 200);
    const bodyDetail = await resDetail.json();
    assert.equal(bodyDetail.success, true);
    assert.equal(bodyDetail.data.room.roomCode, "ADMR01");
  } finally {
    Admin.findById = origFindAdmin;
    GameRoom.find = origFind;
    GameRoom.countDocuments = origCount;
    GameRoom.findOne = origFindOne;
  }
});

// -------------------------------------------------------------
// 3. Admin Room Force Cancel & Force Expire
// -------------------------------------------------------------
test("ADMIN ROOMS: Force cancel and force expire room", async () => {
  const origFindAdmin = Admin.findById;
  const origFindById = GameRoom.findById;
  const origCancelRoom = roomService.cancelRoomAndRefund;
  const origAuditCreate = AdminAuditLog.create;

  Admin.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: "64b000000000000000000001",
        name: "Admin User",
        role: "admin",
        isActive: true,
      }),
    }),
  });
  AdminAuditLog.create = async () => ({});

  const mockRoom = {
    _id: "64b000000000000000000030",
    roomCode: "CNCL01",
    status: "waiting",
    entryFee: 100,
    players: [{ user: "64b000000000000000000001" }],
  };

  GameRoom.findById = async () => mockRoom;

  let cancelCalls = [];
  roomService.cancelRoomAndRefund = async (room, reason, targetStatus, cancelledBy) => {
    cancelCalls.push({ room, reason, targetStatus, cancelledBy });
    return {
      _id: room._id,
      status: targetStatus || "cancelled",
      cancelledReason: reason,
      cancelledBy,
    };
  };

  const token = signAdmin("64b000000000000000000001");

  try {
    // 1. Force Cancel
    const resCancel = await callApi("POST", `/api/admin/rooms/${mockRoom._id}/cancel`, {
      token,
      body: { reason: "Room stuck on waiting" },
    });
    assert.equal(resCancel.status, 200);
    const bodyCancel = await resCancel.json();
    assert.equal(bodyCancel.success, true);
    assert.equal(cancelCalls[0].targetStatus, "cancelled");

    // 2. Force Expire
    const resExpire = await callApi("POST", `/api/admin/rooms/${mockRoom._id}/expire`, {
      token,
      body: { reason: "Force expiring room" },
    });
    assert.equal(resExpire.status, 200);
    const bodyExpire = await resExpire.json();
    assert.equal(bodyExpire.success, true);
    assert.equal(cancelCalls[1].targetStatus, "expired");
  } finally {
    Admin.findById = origFindAdmin;
    GameRoom.findById = origFindById;
    roomService.cancelRoomAndRefund = origCancelRoom;
    AdminAuditLog.create = origAuditCreate;
  }
});

// -------------------------------------------------------------
// 4. Admin Economy Settings (GET & PATCH)
// -------------------------------------------------------------
test("ADMIN ECONOMY: Get and patch economy settings", async () => {
  const origFindAdmin = Admin.findById;
  const origAuditCreate = AdminAuditLog.create;

  Admin.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: "64b000000000000000000001",
        name: "Admin User",
        role: "admin",
        isActive: true,
      }),
    }),
  });
  AdminAuditLog.create = async () => ({});

  const token = signAdmin("64b000000000000000000001");

  try {
    // 1. GET settings
    const resGet = await callApi("GET", "/api/admin/settings/economy", { token });
    assert.equal(resGet.status, 200);
    const bodyGet = await resGet.json();
    assert.equal(bodyGet.success, true);
    assert.ok(typeof bodyGet.data.platformFeePercent === "number");
    assert.ok(typeof bodyGet.data.roomWaitingTtlMinutes === "number");

    // 2. PATCH settings with valid parameters
    const resPatch = await callApi("PATCH", "/api/admin/settings/economy", {
      token,
      body: {
        platformFeePercent: 12,
        roomWaitingTtlMinutes: 15,
        maxEntryFee: 50000,
      },
    });
    assert.equal(resPatch.status, 200);
    const bodyPatch = await resPatch.json();
    assert.equal(bodyPatch.success, true);
    assert.equal(bodyPatch.data.platformFeePercent, 12);
    assert.equal(bodyPatch.data.roomWaitingTtlMinutes, 15);
    assert.equal(bodyPatch.data.maxEntryFee, 50000);

    // Reset back to defaults
    config.economy.platformFeePercent = 10;
    config.economy.roomWaitingTtlMinutes = 10;
    config.economy.maxEntryFee = 100000;
  } finally {
    Admin.findById = origFindAdmin;
    AdminAuditLog.create = origAuditCreate;
  }
});

// -------------------------------------------------------------
// 5. Admin Room Analytics & Fraud Alerts
// -------------------------------------------------------------
test("ADMIN ANALYTICS & FRAUD: Room analytics and fraud alerts", async () => {
  const origFindAdmin = Admin.findById;
  const origAggregate = GameRoom.aggregate;

  Admin.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: "64b000000000000000000001",
        name: "Admin User",
        role: "admin",
        isActive: true,
      }),
    }),
  });

  // Mock aggregate for analytics and fraud alerts
  GameRoom.aggregate = async (pipeline) => {
    // If facet pipeline (analytics)
    if (pipeline[1] && pipeline[1].$facet) {
      return [{
        statusBreakdown: [{ _id: "waiting", count: 5 }, { _id: "finished", count: 10 }],
        modeBreakdown: [{ _id: "twoPlayer", count: 12 }, { _id: "fourPlayer", count: 3 }],
        financials: [{ totalRooms: 15, totalWagered: 1500, settledCommission: 150, settledPayouts: 1350 }],
        topHosts: [{ _id: "user1", roomsCreated: 5, totalWagered: 500, user: { name: "Top Host" } }],
      }];
    }
    // If fraud alerts pipeline
    return [];
  };

  const token = signAdmin("64b000000000000000000001");

  try {
    // 1. GET /api/admin/analytics/rooms
    const resAnalytics = await callApi("GET", "/api/admin/analytics/rooms", { token });
    assert.equal(resAnalytics.status, 200);
    const bodyAnalytics = await resAnalytics.json();
    assert.equal(bodyAnalytics.success, true);
    assert.equal(bodyAnalytics.data.summary.totalRooms, 15);
    assert.equal(bodyAnalytics.data.summary.totalPlatformCommission, 150);

    // 2. GET /api/admin/fraud/room-alerts
    const resFraud = await callApi("GET", "/api/admin/fraud/room-alerts", { token });
    assert.equal(resFraud.status, 200);
    const bodyFraud = await resFraud.json();
    assert.equal(bodyFraud.success, true);
    assert.ok(Array.isArray(bodyFraud.data.alerts));
  } finally {
    Admin.findById = origFindAdmin;
    GameRoom.aggregate = origAggregate;
  }
});

