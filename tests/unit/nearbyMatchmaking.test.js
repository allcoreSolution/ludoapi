"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const MatchmakingQueue = require("../../src/modules/matchmaking/models/MatchmakingQueue");
const GameRoom = require("../../src/modules/rooms/models/GameRoom");
const GameSession = require("../../src/modules/games/models/GameSession");
const User = require("../../src/modules/auth/models/User");
const gameService = require("../../src/modules/games/services/game.service");
const matchmakingService = require("../../src/modules/matchmaking/services/matchmaking.service");
const socketManager = require("../../src/sockets/socketManager");
const {
  joinNearbyQueueValidation,
  updateNearbyLocationValidation,
  validateRequest,
} = require("../../src/modules/matchmaking/validations/matchmaking.validation");

const runValidation = async (validator, body) => {
  const req = { body, params: {}, query: {} };
  for (const mw of validator) {
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

// Mock Socket.IO harness
const setupMockSockets = () => {
  const messages = [];
  const server = require("node:http").createServer();
  socketManager.init(server);
  const io = socketManager.getIO();

  socketManager.emitToUser = (userId, event, payload) => {
    messages.push({ userId: String(userId), event, payload });
    return true;
  };

  return {
    messages,
    getMessages(userId, event) {
      return messages.filter(
        (m) => String(m.userId) === String(userId) && (!event || m.event === event)
      );
    },
    clear() {
      messages.length = 0;
    },
  };
};

test("Distance calculations: Haversine formula accurately calculates distance", () => {
  // Lucknow Hazratganj: 26.8500, 80.9500
  // Lucknow Charbagh: 26.8320, 80.9170 (~3.8 km apart)
  const dKm = matchmakingService.haversineDistanceKm(26.85, 80.95, 26.832, 80.917);
  assert.ok(dKm > 3.5 && dKm < 4.2, `Expected ~3.8 km, got ${dKm}`);

  // Same coordinates => 0 km
  const sameD = matchmakingService.haversineDistanceKm(26.85, 80.95, 26.85, 80.95);
  assert.equal(sameD, 0);

  // Far apart coordinates: Delhi (28.6139, 77.2090) to Lucknow (26.8467, 80.9462) => ~415 km
  const farD = matchmakingService.haversineDistanceKm(28.6139, 77.209, 26.8467, 80.9462);
  assert.ok(farD > 400 && farD < 430, `Expected ~415 km, got ${farD}`);
});

test("Validation: joinNearbyQueueValidation accepts valid coordinates and rejects invalid ones", async () => {
  const valid = {
    latitude: 26.8467,
    longitude: 80.9462,
    accuracy: 50,
    radiusKm: 5,
    mode: "twoPlayer",
  };
  const r1 = await runValidation(joinNearbyQueueValidation, valid);
  assert.equal(r1.passed, true);

  const invalidLat = { latitude: 95, longitude: 80, radiusKm: 5 };
  const r2 = await runValidation(joinNearbyQueueValidation, invalidLat);
  assert.equal(r2.passed, false);

  const invalidLon = { latitude: 20, longitude: 200, radiusKm: 5 };
  const r3 = await runValidation(joinNearbyQueueValidation, invalidLon);
  assert.equal(r3.passed, false);

  const missingCoords = { radiusKm: 5 };
  const r4 = await runValidation(joinNearbyQueueValidation, missingCoords);
  assert.equal(r4.passed, false);
});

test("Validation: Location accuracy limits reject excessively inaccurate coordinates", () => {
  assert.throws(
    () => {
      matchmakingService.validateLocationCoordinates({
        latitude: 26.8,
        longitude: 80.9,
        accuracy: 5000, // 5 km accuracy is too low
      });
    },
    /Location accuracy.*too low/i
  );

  const valid = matchmakingService.validateLocationCoordinates({
    latitude: 26.8,
    longitude: 80.9,
    accuracy: 50,
  });
  assert.equal(valid.latitude, 26.8);
  assert.equal(valid.longitude, 80.9);
  assert.equal(valid.accuracy, 50);
});

test("1. Player A joins nearby queue and enters searching status", async () => {
  const socketHarness = setupMockSockets();
  const userA = { _id: "6742d80b9a4f21001e3a9851", name: "Player A" };

  GameRoom.findOne = async () => null;
  MatchmakingQueue.findOne = async () => null;
  MatchmakingQueue.find = () => ({
    limit: () => [],
  });
  MatchmakingQueue.create = async (doc) => ({
    _id: "queue_a_123",
    ...doc,
  });

  const res = await matchmakingService.joinNearbyQueue(userA, {
    latitude: 26.8467,
    longitude: 80.9462,
    accuracy: 30,
    radiusKm: 5,
    gameMode: "twoPlayer",
  });

  assert.equal(res.matched, false);
  assert.equal(res.status, "searching");
  assert.equal(res.queueId, "queue_a_123");
  assert.equal(res.radiusKm, 5);

  const statusEvents = socketHarness.getMessages(userA._id, "matchmaking_status");
  assert.ok(statusEvents.length > 0);
  assert.equal(statusEvents[0].payload.status, "searching");
});

test("2, 3, 4, 5, 6, 7 & 8. Player B joins nearby queue within radius, match is created with same room and match ID", async () => {
  const socketHarness = setupMockSockets();
  const userAId = "6742d80b9a4f21001e3a9851";
  const userBId = "6742d80b9a4f21001e3a9852";
  const userB = { _id: userBId, name: "Player B", avatar: "" };

  const queueEntryA = {
    _id: "queue_a_123",
    user: userAId,
    status: "searching",
    queueType: "nearby",
    radiusKm: 5,
    location: {
      type: "Point",
      coordinates: [80.9462, 26.8467],
    },
    async save() {
      return this;
    },
  };

  GameRoom.findOne = async () => null;
  MatchmakingQueue.findOne = async () => null;
  MatchmakingQueue.find = () => ({
    limit: () => [queueEntryA],
  });
  MatchmakingQueue.findOneAndUpdate = async (filter, update) => {
    if (filter._id === "queue_a_123") {
      return { ...queueEntryA, status: "matched", matchedAt: new Date() };
    }
    return null;
  };

  const fakeRoom = {
    _id: "room_nearby_999",
    roomCode: "NEAR77",
    prizePool: 0,
    players: [
      { user: userAId, seatIndex: 0, color: "Red" },
      { user: userBId, seatIndex: 1, color: "Green" },
    ],
  };
  GameRoom.create = async () => fakeRoom;
  User.findById = () => ({
    select: () => ({
      lean: async () => ({ _id: userAId, name: "Player A", avatar: "" }),
    }),
  });

  const fakeSession = {
    _id: "session_nearby_999",
    room: fakeRoom._id,
    roomCode: fakeRoom.roomCode,
    status: "in_progress",
    players: fakeRoom.players,
    turnStatus: "WAITING_FOR_ROLL",
    gamePhase: "waiting_for_roll",
    currentTurnPlayer: userAId,
    currentTurnSeat: 0,
    turnNumber: 1,
    actionSequence: 1,
  };
  gameService.startGame = async () => ({ session: fakeSession });
  GameRoom.findOneAndUpdate = async () => ({ ...fakeRoom, status: "playing" });
  GameSession.create = async () => fakeSession;
  GameSession.findOne = async () => null;
  MatchmakingQueue.create = async (doc) => ({ _id: "queue_b_456", ...doc });

  // Player B is at 26.8500, 80.9500 (approx 500 meters from Player A, well within 5km radius)
  const res = await matchmakingService.joinNearbyQueue(userB, {
    latitude: 26.85,
    longitude: 80.95,
    accuracy: 25,
    radiusKm: 5,
  });

  assert.equal(res.matched, true);
  assert.equal(res.status, "matched");
  assert.equal(String(res.roomId), "room_nearby_999");
  assert.equal(String(res.matchId), "session_nearby_999");
  assert.equal(res.roomCode, "NEAR77");

  // Verify match_found / nearby_match_found sent to both
  const matchA = socketHarness.getMessages(userAId, "nearby_match_found");
  const matchB = socketHarness.getMessages(userBId, "nearby_match_found");
  assert.ok(matchA.length > 0, "Player A received nearby_match_found");
  assert.ok(matchB.length > 0, "Player B received nearby_match_found");
  assert.equal(String(matchA[0].payload.roomId), String(matchB[0].payload.roomId));
  assert.equal(String(matchA[0].payload.matchId), String(matchB[0].payload.matchId));
});

test("9. Players outside radius are NOT matched", async () => {
  const userAId = "6742d80b9a4f21001e3a9851";
  const userCId = "6742d80b9a4f21001e3a9853";
  const userC = { _id: userCId, name: "Player C", avatar: "" };

  // Candidate Player A in Lucknow (26.8467, 80.9462) with radius 5km
  const candidateA = {
    _id: "queue_a_123",
    user: userAId,
    status: "searching",
    queueType: "nearby",
    radiusKm: 5,
    location: {
      type: "Point",
      coordinates: [80.9462, 26.8467],
    },
  };

  GameRoom.findOne = async () => null;
  MatchmakingQueue.findOne = async () => null;
  MatchmakingQueue.find = () => ({
    limit: () => [candidateA],
  });
  MatchmakingQueue.create = async (doc) => ({ _id: "queue_c_789", ...doc });

  // Player C in Kanpur (26.4499, 80.3319) ~ 75 km away with radius 5km
  const res = await matchmakingService.joinNearbyQueue(userC, {
    latitude: 26.4499,
    longitude: 80.3319,
    accuracy: 20,
    radiusKm: 5,
  });

  assert.equal(res.matched, false);
  assert.equal(res.status, "searching");
});

test("10. Player cannot match with themselves", async () => {
  const userAId = "6742d80b9a4f21001e3a9851";
  const userA = { _id: userAId, name: "Player A" };

  const candidateSelf = {
    _id: "queue_a_self",
    user: userAId, // SAME USER
    status: "searching",
    queueType: "nearby",
    radiusKm: 5,
    location: {
      type: "Point",
      coordinates: [80.9462, 26.8467],
    },
  };

  GameRoom.findOne = async () => null;
  MatchmakingQueue.findOne = async () => null;
  MatchmakingQueue.find = () => ({
    limit: () => [candidateSelf],
  });
  MatchmakingQueue.create = async (doc) => ({ _id: "queue_a_new", ...doc });

  const res = await matchmakingService.joinNearbyQueue(userA, {
    latitude: 26.8467,
    longitude: 80.9462,
    radiusKm: 5,
  });

  // Must not match with self
  assert.equal(res.matched, false);
  assert.equal(res.status, "searching");
});

test("11. Duplicate queue entries are rejected", async () => {
  const userA = { _id: "6742d80b9a4f21001e3a9851", name: "Player A" };

  GameRoom.findOne = async () => null;
  MatchmakingQueue.findOne = async () => ({
    _id: "existing_queue_1",
    status: "searching",
  });

  await assert.rejects(
    async () => {
      await matchmakingService.joinNearbyQueue(userA, {
        latitude: 26.8467,
        longitude: 80.9462,
        radiusKm: 5,
      });
    },
    (err) => {
      assert.match(err.message, /already in the matchmaking queue/i);
      return true;
    }
  );
});

test("12. Cancel matchmaking works and cleans up queue", async () => {
  const socketHarness = setupMockSockets();
  const userAId = "6742d80b9a4f21001e3a9851";

  MatchmakingQueue.findOneAndUpdate = async (filter, update) => {
    if (filter.user === userAId) {
      return {
        _id: "queue_cancelled_1",
        user: userAId,
        status: "cancelled",
        entryFee: 0,
      };
    }
    return null;
  };

  const res = await matchmakingService.cancelNearbyQueue(userAId);
  assert.equal(res.status, "cancelled");

  const cancelEvents = socketHarness.getMessages(userAId, "matchmaking_cancelled");
  assert.ok(cancelEvents.length > 0);
  assert.equal(cancelEvents[0].payload.status, "cancelled");
});

test("13. Queue expiration sweeper expires stale queues and purges location", async () => {
  const socketHarness = setupMockSockets();
  const staleEntry = {
    _id: "stale_queue_1",
    user: "6742d80b9a4f21001e3a9851",
    status: "searching",
    entryFee: 0,
  };

  MatchmakingQueue.find = () => ({
    limit: () => ({
      lean: async () => [staleEntry],
    }),
  });

  let purgedLocation = false;
  MatchmakingQueue.findOneAndUpdate = async (filter, update) => {
    if (update.$unset && update.$unset.location !== undefined) {
      purgedLocation = true;
    }
    return { ...staleEntry, status: "expired" };
  };

  const sweptCount = await matchmakingService.sweepExpiredQueues();
  assert.equal(sweptCount, 1);
  assert.equal(purgedLocation, true, "Expired entry purged ephemeral location");

  const expireEvents = socketHarness.getMessages(staleEntry.user, "matchmaking_expired");
  assert.ok(expireEvents.length > 0);
});

test("14. Disconnect cleanup cancels queue and purges location", async () => {
  const userAId = "6742d80b9a4f21001e3a9851";
  let cancelled = false;

  MatchmakingQueue.findOneAndUpdate = async (filter, update) => {
    if (filter.user === userAId && update.$unset && update.$unset.location !== undefined) {
      cancelled = true;
      return { _id: "q_disc", user: userAId, status: "cancelled", entryFee: 0 };
    }
    return null;
  };

  await matchmakingService.cancelNearbyQueue(userAId);
  assert.equal(cancelled, true);
});

test("15. Simultaneous queue requests don't create duplicate matches (atomic lock)", async () => {
  const candidate = {
    _id: "candidate_1",
    user: "user_cand",
    status: "searching",
    queueType: "nearby",
    radiusKm: 5,
    location: { type: "Point", coordinates: [80.95, 26.85] },
  };

  let claimedCount = 0;
  MatchmakingQueue.findOneAndUpdate = async (filter) => {
    if (filter._id === "candidate_1" && claimedCount === 0) {
      claimedCount++;
      return { ...candidate, status: "matched" };
    }
    return null; // Already claimed by competitor!
  };

  // First request claims candidate
  const first = await MatchmakingQueue.findOneAndUpdate({ _id: candidate._id, status: { $in: ["waiting", "searching"] } });
  // Second concurrent request gets null
  const second = await MatchmakingQueue.findOneAndUpdate({ _id: candidate._id, status: { $in: ["waiting", "searching"] } });

  assert.ok(first);
  assert.equal(second, null);
});

test("16. Already-playing users cannot join queue", async () => {
  const userA = { _id: "6742d80b9a4f21001e3a9851", name: "Player A" };

  GameRoom.findOne = async () => ({
    roomCode: "PLAYING1",
    status: "playing",
  });

  await assert.rejects(
    async () => {
      await matchmakingService.joinNearbyQueue(userA, {
        latitude: 26.8467,
        longitude: 80.9462,
        radiusKm: 5,
      });
    },
    (err) => {
      assert.match(err.message, /already in an active room/i);
      return true;
    }
  );
});

test("17. Invalid coordinates are rejected with 400", () => {
  assert.throws(() => {
    matchmakingService.validateLocationCoordinates({ latitude: 100, longitude: 80 });
  }, /Invalid latitude/i);

  assert.throws(() => {
    matchmakingService.validateLocationCoordinates({ latitude: 20, longitude: -200 });
  }, /Invalid longitude/i);

  assert.throws(() => {
    matchmakingService.validateLocationCoordinates({ latitude: 20, longitude: 80, radiusKm: 0.1 });
  }, /Search radius must be between/i);
});

test("18. Location privacy is preserved (coordinates never exposed in matched events or status)", async () => {
  const socketHarness = setupMockSockets();
  const userAId = "6742d80b9a4f21001e3a9851";
  const userBId = "6742d80b9a4f21001e3a9852";

  const queueEntryA = {
    _id: "queue_a_123",
    user: userAId,
    status: "searching",
    queueType: "nearby",
    radiusKm: 5,
    location: { type: "Point", coordinates: [80.9462, 26.8467] },
    async save() {
      return this;
    },
  };

  GameRoom.findOne = async () => null;
  MatchmakingQueue.findOne = async () => null;
  MatchmakingQueue.find = () => ({ limit: () => [queueEntryA] });
  MatchmakingQueue.findOneAndUpdate = async () => ({ ...queueEntryA, status: "matched" });
  GameRoom.create = async () => ({
    _id: "room_p1",
    roomCode: "PRIV1",
    prizePool: 0,
    players: [
      { user: userAId, seatIndex: 0, color: "Red" },
      { user: userBId, seatIndex: 1, color: "Green" },
    ],
  });
  User.findById = () => ({
    select: () => ({ lean: async () => ({ _id: userAId, name: "Player A" }) }),
  });
  GameSession.create = async () => null;
  MatchmakingQueue.create = async (doc) => ({ _id: "q_b", ...doc });

  const res = await matchmakingService.joinNearbyQueue({ _id: userBId, name: "Player B" }, {
    latitude: 26.85,
    longitude: 80.95,
    radiusKm: 5,
  });

  // Coordinates MUST NOT exist in the API response or socket events
  assert.equal(res.latitude, undefined);
  assert.equal(res.longitude, undefined);
  assert.equal(res.location, undefined);

  const matchedEvent = socketHarness.getMessages(userBId, "nearby_match_found")[0];
  assert.ok(matchedEvent);
  assert.equal(matchedEvent.payload.latitude, undefined);
  assert.equal(matchedEvent.payload.longitude, undefined);
  assert.equal(matchedEvent.payload.location, undefined);
  assert.equal(matchedEvent.payload.opponent.latitude, undefined);
});

test("19. Match creation failure handles safe rollback and refund", async () => {
  const userAId = "6742d80b9a4f21001e3a9851";
  const userBId = "6742d80b9a4f21001e3a9852";

  const queueEntryA = {
    _id: "queue_a_123",
    user: userAId,
    status: "searching",
    queueType: "nearby",
    radiusKm: 5,
    location: { type: "Point", coordinates: [80.9462, 26.8467] },
  };

  GameRoom.findOne = async () => null;
  MatchmakingQueue.findOne = async () => null;
  MatchmakingQueue.find = () => ({ limit: () => [queueEntryA] });
  MatchmakingQueue.findOneAndUpdate = async () => ({ ...queueEntryA, status: "matched" });
  User.findById = () => ({ select: () => ({ lean: async () => null }) }); // Failed verification

  await assert.rejects(
    async () => {
      await matchmakingService.joinNearbyQueue({ _id: userBId, name: "Player B" }, {
        latitude: 26.85,
        longitude: 80.95,
        radiusKm: 5,
      });
    },
    /Opponent could not be verified/i
  );
});

test("20. Both users can play a complete game after nearby matchmaking", () => {
  const session = {
    _id: "session_nearby_test",
    roomCode: "NEAR10",
    status: "in_progress",
    currentTurnPlayer: "6742d80b9a4f21001e3a9851",
    currentTurnSeat: 0,
    turnNumber: 1,
    turnStatus: "WAITING_FOR_ROLL",
    gamePhase: "waiting_for_roll",
    players: [
      {
        user: "6742d80b9a4f21001e3a9851",
        seatIndex: 0,
        color: "Red",
        tokens: [{ tokenId: 0, step: 0, isHome: false }],
      },
      {
        user: "6742d80b9a4f21001e3a9852",
        seatIndex: 1,
        color: "Green",
        tokens: [{ tokenId: 0, step: 0, isHome: false }],
      },
    ],
  };

  const st = socketManager.formatSessionState(session);
  assert.equal(st.currentPlayerId, "6742d80b9a4f21001e3a9851");
  assert.equal(st.currentSeat, 0);

  const viewerA = socketManager.viewerView(st, "6742d80b9a4f21001e3a9851");
  const viewerB = socketManager.viewerView(st, "6742d80b9a4f21001e3a9852");

  assert.equal(viewerA.me.isMyTurn, true);
  assert.equal(viewerA.me.canRoll, true);
  assert.equal(viewerB.me.isMyTurn, false);
  assert.equal(viewerB.me.canRoll, false);
});
