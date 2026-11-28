"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const jwt = require("jsonwebtoken");

const config = require("../../config/env");
const app = require("../../app");
const GameRoom = require("../../src/modules/rooms/models/GameRoom");
const roomService = require("../../src/modules/rooms/services/room.service");

let server;
let base;

// In-memory mock store for GameRoom queries
const mockRooms = new Map();

// Save original GameRoom methods to restore after tests
const origFindOne = GameRoom.findOne;

test.before(async () => {
  // Override GameRoom.findOne with lean/exec support
  GameRoom.findOne = (query) => {
    let result = null;
    if (query && query.roomCode) {
      result = mockRooms.get(String(query.roomCode).toUpperCase()) || null;
    }

    const queryObj = {
      populate: () => queryObj,
      lean: () => Promise.resolve(result ? JSON.parse(JSON.stringify(result)) : null),
      sort: () => queryObj,
      exec: () => Promise.resolve(result ? JSON.parse(JSON.stringify(result)) : null),
      then: (resolve, reject) => queryObj.exec().then(resolve, reject),
    };
    return queryObj;
  };

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  GameRoom.findOne = origFindOne;
  server.close();
});

const get = (path, headers = {}) =>
  fetch(base + path, {
    method: "GET",
    headers,
  });

// -------------------------------------------------------------
// Test Helpers
// -------------------------------------------------------------
const seedRoom = (roomCode, overrides = {}) => {
  const code = String(roomCode).toUpperCase();
  const roomDoc = {
    _id: `room_${code}`,
    roomCode: code,
    host: "user_host_123",
    players: [
      {
        user: "user_host_123",
        name: "HostPlayer",
        seatIndex: 0,
        color: "Red",
        isReady: true,
        isHost: true,
      },
    ],
    maxPlayers: 2,
    gameMode: "twoPlayer",
    entryFee: 100,
    prizePool: 200,
    status: "waiting",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  mockRooms.set(code, roomDoc);
  return roomDoc;
};

// =============================================================
// Tests
// =============================================================

test("1. Valid room invitation landing page returns 200 HTML with code and deep link", async () => {
  seedRoom("INV101", { maxPlayers: 2, entryFee: 50 });

  const res = await get("/invite/INV101");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);

  const html = await res.text();
  assert.ok(html.includes("INV101"), "Landing page contains room code");
  assert.ok(html.includes("ludosupreme://join?code=INV101"), "Landing page contains deep link");
  assert.ok(html.includes("50 🪙"), "Landing page shows entry fee");
  assert.ok(html.includes("1 / 2"), "Landing page shows available slots / players");
  assert.ok(html.includes("badge-success"), "Landing page shows JOINABLE status badge");
  assert.ok(html.includes("Open Ludo Supreme"), "Landing page contains Open Ludo Supreme button");
  assert.ok(html.includes("Download App"), "Landing page contains Download App button");
});

test("2. Invalid room code parameter on /invite returns 400 Validation Failed", async () => {
  const res = await get("/invite/short");
  assert.equal(res.status, 400);

  const data = await res.json();
  assert.equal(data.success, false);
  assert.equal(data.message, "Validation Failed");
  assert.ok(data.errors.some((e) => e.field === "roomCode"));
});

test("3. Non-existent room on /invite returns 404 HTML with NOT FOUND badge", async () => {
  const res = await get("/invite/NOPE99");
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /text\/html/);

  const html = await res.text();
  assert.ok(html.includes("NOT FOUND"));
  assert.ok(html.includes("Room not found"));
});

test("4. Full room landing page returns 200 HTML with ROOM FULL badge", async () => {
  seedRoom("FULL01", {
    maxPlayers: 2,
    players: [
      { user: "u1", name: "P1", seatIndex: 0, color: "Red" },
      { user: "u2", name: "P2", seatIndex: 1, color: "Green" },
    ],
  });

  const res = await get("/invite/FULL01");
  assert.equal(res.status, 200);

  const html = await res.text();
  assert.ok(html.includes("ROOM FULL"));
  assert.ok(html.includes("2 / 2"));
  assert.ok(html.includes("badge-warning"));
});

test("5. Expired room landing page returns 200 HTML with EXPIRED badge", async () => {
  // Stale room: updatedAt older than 35 mins
  const oldDate = new Date(Date.now() - 35 * 60_000);
  seedRoom("EXPD01", {
    status: "waiting",
    updatedAt: oldDate,
  });

  const res = await get("/invite/EXPD01");
  assert.equal(res.status, 200);

  const html = await res.text();
  assert.ok(html.includes("EXPIRED"));
  assert.ok(html.includes("Room has expired"));
});

test("6. Playing / started match landing page returns 200 HTML with MATCH STARTED badge", async () => {
  seedRoom("PLAY01", {
    status: "playing",
  });

  const res = await get("/invite/PLAY01");
  assert.equal(res.status, 200);

  const html = await res.text();
  assert.ok(html.includes("MATCH STARTED"));
  assert.ok(html.includes("Game has already started"));
});

test("7. Cancelled room landing page returns 200 HTML with cancelled message", async () => {
  seedRoom("CANC01", {
    status: "cancelled",
  });

  const res = await get("/invite/CANC01");
  assert.equal(res.status, 200);

  const html = await res.text();
  assert.ok(html.includes("Room was cancelled"));
});

test("8. GET /api/rooms/:roomCode/check returns full availability schema for active room", async () => {
  seedRoom("CHCK01", { maxPlayers: 4, entryFee: 200 });

  const res = await get("/api/rooms/CHCK01/check");
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.roomCode, "CHCK01");
  assert.equal(body.roomExists, true);
  assert.equal(body.status, "waiting");
  assert.equal(body.isJoinable, true);
  assert.equal(body.isFull, false);
  assert.equal(body.currentPlayers, 1);
  assert.equal(body.maxPlayers, 4);
  assert.equal(body.availableSlots, 3);
  assert.equal(body.gameStarted, false);
  assert.equal(body.roomExpired, false);
  assert.equal(body.message, "Room is available to join");
  assert.equal(body.entryCoins, 200);
  assert.equal(body.entryFee, 200);
  assert.equal(body.gameMode, "twoPlayer");
});

test("9. GET /api/rooms/:roomCode/check returns 404 and roomExists: false for non-existent room", async () => {
  const res = await get("/api/rooms/UNKN99/check");
  assert.equal(res.status, 404);

  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.roomCode, "UNKN99");
  assert.equal(body.roomExists, false);
  assert.equal(body.isJoinable, false);
  assert.equal(body.message, "Room not found");
});

test("10. GET /api/rooms/:roomCode/check returns isFull: true when room is full", async () => {
  seedRoom("FULL99", {
    maxPlayers: 2,
    players: [
      { user: "u1", name: "P1" },
      { user: "u2", name: "P2" },
    ],
  });

  const res = await get("/api/rooms/FULL99/check");
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.isJoinable, false);
  assert.equal(body.isFull, true);
  assert.equal(body.availableSlots, 0);
  assert.equal(body.message, "Room is full");
});

test("11. GET /api/rooms/:roomCode/check rejects invalid roomCode format with 400", async () => {
  const res = await get("/api/rooms/invalid-code/check");
  assert.equal(res.status, 400);

  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.message, "Validation Failed");
});

test("12. GET /api/rooms/share-template returns base share template", async () => {
  const res = await get("/api/rooms/share-template");
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.appName, "Ludo Supreme");
  assert.equal(body.data.title, "Ludo Supreme Match Invitation");
  assert.ok(Array.isArray(body.data.instructions));
  assert.ok(Array.isArray(body.data.hashtags));
  assert.equal(body.data.shareMessage, null); // No roomCode provided yet
});

test("13. GET /api/rooms/share-template generates formatted dynamic invitation message", async () => {
  const customUrl = "https://ludoapi-jupm.onrender.com/invite/DYN123";
  const res = await get(
    `/api/rooms/share-template?roomCode=DYN123&entryCoins=100&gameMode=twoPlayer&inviteUrl=${encodeURIComponent(customUrl)}`
  );
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.roomCode, "DYN123");
  assert.equal(body.data.entryCoins, 100);
  assert.equal(body.data.gameMode, "twoPlayer");
  assert.equal(body.data.deepLinkUrl, "ludosupreme://join?code=DYN123");
  assert.equal(body.data.inviteUrl, customUrl);

  const msg = body.data.shareMessage;
  assert.ok(msg.includes("🔑 Room Code: DYN123"), "Message includes room code");
  assert.ok(msg.includes("🪙 Entry: 100 Coins"), "Message includes coins");
  assert.ok(msg.includes("🎮 Mode: 2 Players"), "Message includes game mode");
  assert.ok(msg.includes(customUrl), "Message includes invite URL");
  assert.ok(msg.includes("📲 How to Join:"), "Message includes instructions");
});

test("14. GET /api/rooms/share-template validates query parameters and rejects invalid entryCoins", async () => {
  const res = await get("/api/rooms/share-template?entryCoins=-20");
  assert.equal(res.status, 400);

  const body = await res.json();
  assert.equal(body.success, false);
  assert.ok(body.errors.some((e) => e.field === "entryCoins"));
});

test("15. Rate limiting headers exist on room check endpoint", async () => {
  const prev = config.rateLimit.enabled;
  config.rateLimit.enabled = true;
  try {
    const res = await get("/api/rooms/CHCK01/check");
    assert.ok(res.headers.get("ratelimit-limit"), "RateLimit-Limit header present");
    assert.ok(res.headers.get("ratelimit-remaining"), "RateLimit-Remaining header present");
  } finally {
    config.rateLimit.enabled = prev;
  }
});

test("16. Security check: public endpoints never expose player IDs or private user data", async () => {
  seedRoom("SECR01", {
    players: [
      { user: "user_secret_id_9999", name: "SecretPlayer", email: "secret@example.com" },
    ],
  });

  const checkRes = await get("/api/rooms/SECR01/check");
  const checkText = await checkRes.text();
  assert.equal(checkText.includes("user_secret_id_9999"), false);
  assert.equal(checkText.includes("secret@example.com"), false);

  const inviteRes = await get("/invite/SECR01");
  const inviteText = await inviteRes.text();
  assert.equal(inviteText.includes("user_secret_id_9999"), false);
  assert.equal(inviteText.includes("secret@example.com"), false);
});

test("17. Android App Links verification endpoint /.well-known/assetlinks.json", async () => {
  const origFp = process.env.ANDROID_SHA256_FINGERPRINTS;
  process.env.ANDROID_SHA256_FINGERPRINTS = "14:6D:E9:4A:12:34:56:78:90:AB:CD:EF";

  try {
    const res = await get("/.well-known/assetlinks.json");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.ok(res.headers.get("cache-control").includes("public"));

    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body[0].target.namespace, "android_app");
    assert.equal(body[0].target.package_name, config.appLinks.packageName);
    assert.deepEqual(body[0].target.sha256_cert_fingerprints, ["14:6D:E9:4A:12:34:56:78:90:AB:CD:EF"]);
  } finally {
    process.env.ANDROID_SHA256_FINGERPRINTS = origFp;
  }
});

test("18. Existing protected route GET /api/rooms/:roomCode still requires JWT", async () => {
  const res = await get("/api/rooms/CHCK01");
  assert.equal(res.status, 401, "Protected room route rejects request without JWT");
});

test("19. GET /join/:roomCode primary deep link route returns 200 HTML with code and Open Ludo Supreme", async () => {
  seedRoom("HYYKM3", { maxPlayers: 2, entryFee: 100, gameMode: "twoPlayer" });

  const res = await get("/join/HYYKM3");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);

  const html = await res.text();
  assert.ok(html.includes("HYYKM3"), "Landing page contains room code");
  assert.ok(html.includes("ludosupreme://join?code=HYYKM3"), "Landing page contains deep link");
  assert.ok(html.includes("Open Ludo Supreme"), "Landing page contains Open Ludo Supreme button");
  assert.ok(html.includes("100 🪙"), "Landing page shows coins");
  assert.ok(html.includes("2 Players"), "Landing page shows game mode");
});

test("20. GET /join/:roomCode with invalid code returns 400 Validation Failed", async () => {
  const res = await get("/join/bad!");
  assert.equal(res.status, 400);

  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.message, "Validation Failed");
});

test("21. GET /api/rooms/share-template without explicit inviteUrl defaults to /join/:roomCode", async () => {
  const res = await get("/api/rooms/share-template?roomCode=HYYKM3&entryCoins=100&gameMode=twoPlayer");
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(body.data.inviteUrl.includes("/join/HYYKM3"), "Default inviteUrl uses /join/:roomCode");
  assert.ok(body.data.shareMessage.includes("/join/HYYKM3"), "Share message contains /join/ link");
});
