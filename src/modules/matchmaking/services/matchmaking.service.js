"use strict";

const crypto = require("crypto");
const config = require("../../../../config/env");
const AppError = require("../../../../utils/AppError");
const logger = require("../../../../utils/logger");
const { generateRoomCode } = require("../../../../utils/secureRandom");

const MatchmakingQueue = require("../models/MatchmakingQueue");
const GameRoom = require("../../rooms/models/GameRoom");
const User = require("../../auth/models/User");
const walletService = require("../../wallet/services/wallet.service");
const socketManager = require("../../../sockets/socketManager");
const GameSession = require("../../games/models/GameSession");
const gameService = require("../../games/services/game.service");

const ACTIVE_ROOM_STATUSES = ["waiting", "starting", "playing"];

// ------------------------------------------------------------------
// Distance Calculation & Location Validation
// ------------------------------------------------------------------
const haversineDistanceKm = (lat1, lon1, lat2, lon2) => {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371; // Earth's mean radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const validateLocationCoordinates = ({ latitude, longitude, accuracy, radiusKm }) => {
  const lat = Number(latitude);
  const lon = Number(longitude);

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new AppError("Invalid latitude. Must be between -90 and 90.", 400);
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new AppError("Invalid longitude. Must be between -180 and 180.", 400);
  }

  const maxAccuracy = config.matchmaking?.maxLocationAccuracyMeters || 1000;
  if (accuracy !== undefined && accuracy !== null && accuracy !== "") {
    const acc = Number(accuracy);
    if (!Number.isFinite(acc) || acc < 0) {
      throw new AppError("Invalid accuracy value.", 400);
    }
    if (acc > maxAccuracy) {
      throw new AppError(
        `Location accuracy (${Math.round(acc)}m) is too low. Required accuracy within ${maxAccuracy}m.`,
        400
      );
    }
  }

  const minRadius = config.matchmaking?.minRadiusKm || 0.5;
  const maxRadius = config.matchmaking?.maxRadiusKm || 100;
  const rad =
    radiusKm !== undefined && radiusKm !== null && radiusKm !== ""
      ? Number(radiusKm)
      : config.matchmaking?.defaultRadiusKm || 5;

  if (!Number.isFinite(rad) || rad < minRadius || rad > maxRadius) {
    throw new AppError(`Search radius must be between ${minRadius}km and ${maxRadius}km.`, 400);
  }

  return {
    latitude: lat,
    longitude: lon,
    accuracy: accuracy !== undefined && accuracy !== null && accuracy !== "" ? Number(accuracy) : null,
    radiusKm: rad,
  };
};

// ------------------------------------------------------------------
// Wallet Fee Helpers
// ------------------------------------------------------------------
const payEntryFee = async (userId, fee, label) => {
  if (!(fee > 0)) return null;
  try {
    const { wallet } = await walletService.debitWallet(
      userId,
      fee,
      "game_entry",
      `Entry fee: ${label}`
    );
    return wallet.balance;
  } catch (error) {
    if (error instanceof AppError && error.status === 400 && /Insufficient/.test(error.message)) {
      const available = await walletService.getBalance(userId);
      throw new AppError(`Insufficient coins. Required: ${fee}, Available: ${available}`, 400);
    }
    throw error;
  }
};

const refundEntryFee = async (userId, fee, label, referenceId) => {
  if (!(fee > 0)) return null;
  const { wallet } = await walletService.creditWallet(
    userId,
    fee,
    "refund",
    `Entry fee refund: ${label}`,
    referenceId
  );
  return wallet.balance;
};

const safeRefund = async (userId, fee, label) => {
  try {
    await refundEntryFee(userId, fee, label, `refund:matchmaking:${crypto.randomUUID()}`);
  } catch (error) {
    logger.error("REFUND_FAILED_MANUAL_ACTION_REQUIRED", {
      userId: String(userId),
      fee,
      label,
      err: error,
    });
  }
};

// ------------------------------------------------------------------
// 1. Join Matchmaking Queue
// ------------------------------------------------------------------
const joinQueue = async (user, body = {}) => {
  const userId = user._id;
  const entryFee = body.entryFee !== undefined && body.entryFee !== null ? Number(body.entryFee) : 0;
  const gameMode = body.gameMode ? body.gameMode.trim() : "twoPlayer";
  const maxPlayers = 2; // initially 2-player matchmaking

  // 1. Check if user is already in an active room
  const activeRoom = await GameRoom.findOne({
    "players.user": userId,
    status: { $in: ACTIVE_ROOM_STATUSES },
  });
  if (activeRoom) {
    throw new AppError(
      `You are already in an active room (${activeRoom.roomCode}). Please finish or leave it first.`,
      400,
      { data: { roomCode: activeRoom.roomCode } }
    );
  }

  // 2. Check if user is already in the matchmaking queue
  const existingQueue = await MatchmakingQueue.findOne({
    user: userId,
    status: "waiting",
    expiresAt: { $gt: new Date() },
  });
  if (existingQueue) {
    throw new AppError("You are already in the matchmaking queue.", 400, {
      data: { queueId: existingQueue._id },
    });
  }

  // 3. Deduct entry fee before claiming or enqueuing
  let balance = null;
  if (entryFee > 0) {
    balance = await payEntryFee(userId, entryFee, "matchmaking queue");
  }

  const queueTimeoutSec = config.matchmaking?.queueTimeoutSeconds || 60;
  const expiresAt = new Date(Date.now() + queueTimeoutSec * 1000);

  try {
    // 4. Atomic Search & Match:
    // Try to atomically claim an existing waiting opponent who has the exact same entryFee and gameMode.
    const opponentEntry = await MatchmakingQueue.findOneAndUpdate(
      {
        status: "waiting",
        user: { $ne: userId }, // NEVER match with self!
        entryFee,
        gameMode,
        maxPlayers,
        expiresAt: { $gt: new Date() },
      },
      {
        $set: {
          status: "matched",
          matchedAt: new Date(),
        },
      },
      {
        sort: { queuedAt: 1 }, // FIFO: match player waiting the longest
        returnDocument: "after",
      }
    );

    // ==========================================
    // CASE A: Match Found!
    // ==========================================
    if (opponentEntry) {
      const opponentUser = await User.findById(opponentEntry.user)
        .select("name avatar email")
        .lean();

      if (!opponentUser) {
        // Edge case: Opponent user deleted; rollback & refund
        await safeRefund(userId, entryFee, "opponent user invalid");
        throw new AppError("Opponent could not be verified. Please try again.", 500);
      }

      // Generate room with Player 1 (Host, Seat 0, Red) and Player 2 (Seat 1, Green)
      let room = null;
      for (let attempt = 0; attempt < 5 && !room; attempt++) {
        try {
          room = await GameRoom.create({
            roomCode: generateRoomCode(),
            host: opponentEntry.user,
            players: [
              {
                user: opponentEntry.user,
                name: opponentUser.name,
                avatar: opponentUser.avatar || "",
                seatIndex: 0,
                color: "Red",
                isReady: true,
                isHost: true,
              },
              {
                user: userId,
                name: user.name,
                avatar: user.avatar || "",
                seatIndex: 1,
                color: "Green",
                isReady: true,
                isHost: false,
              },
            ],
            maxPlayers: 2,
            gameMode,
            entryFee,
            prizePool: entryFee * 2,
            status: "waiting",
          });
        } catch (err) {
          if (err.code !== 11000) throw err;
        }
      }

      if (!room) {
        await safeRefund(userId, entryFee, "room generation failed");
        throw new AppError("Failed to initialize match room. Please try again.", 500);
      }

      // Record Player 1 (Opponent) match details
      opponentEntry.matchedRoom = room._id;
      opponentEntry.matchedRoomCode = room.roomCode;
      opponentEntry.opponent = {
        user: userId,
        name: user.name,
        avatar: user.avatar || "",
      };
      await opponentEntry.save();

      // Record Player 2 (Current user) matched queue entry
      const currentQueue = await MatchmakingQueue.create({
        user: userId,
        status: "matched",
        entryFee,
        gameMode,
        maxPlayers: 2,
        matchedRoom: room._id,
        matchedRoomCode: room.roomCode,
        opponent: {
          user: opponentUser._id,
          name: opponentUser.name,
          avatar: opponentUser.avatar || "",
        },
        queuedAt: new Date(),
        matchedAt: new Date(),
        expiresAt,
        isEntryFeeDeducted: entryFee > 0,
      });

      // Start the match right now: nobody has to send start_match, and two phones racing to
      // start the same room can no longer happen. If it fails the old flow still works
      // (clients can call start_match / POST /api/games/start themselves).
      let session = null;
      try {
        ({ session } = await gameService.startGame(opponentEntry.user, room.roomCode));
      } catch (err) {
        logger.error("matchmaking_autostart_failed", { roomCode: room.roomCode, err });
      }
      if (session) {
        // Server-side join: both apps receive dice/move events even before they call join_session.
        socketManager.joinUsersToSession([opponentEntry.user, userId], session);
      }
      const baseState = session ? socketManager.formatSessionState(session) : null;
      const gameId = session ? String(session._id) : null;

      const foundPayload = (viewerId, opponent, me) => {
        const st = baseState ? socketManager.viewerView(baseState, viewerId) : null;
        return {
          status: "matched",
          roomId: room._id,
          roomCode: room.roomCode,
          gameId,
          sessionId: gameId,
          autoStarted: Boolean(session),
          gameMode,
          entryFee,
          prizePool: room.prizePool,
          opponent,
          you: me,
          state: st,
          gameState: st,
        };
      };

      const opponentView = { id: userId, playerId: String(userId), name: user.name, avatar: user.avatar || "", seat: 1, seatIndex: 1, color: "GREEN" };
      const hostView = {
        id: opponentUser._id,
        playerId: String(opponentUser._id),
        name: opponentUser.name,
        avatar: opponentUser.avatar || "",
        seat: 0,
        seatIndex: 0,
        color: "RED",
      };

      const hostPlayerInfo = { userId: String(opponentEntry.user), playerId: String(opponentEntry.user), seat: 0, seatIndex: 0, color: "RED", isHost: true };
      const guestPlayerInfo = { userId: String(userId), playerId: String(userId), seat: 1, seatIndex: 1, color: "GREEN", isHost: false };

      // Emit real-time Socket.IO events to both players (each gets their own "me" block)
      const toHost = foundPayload(opponentEntry.user, opponentView, hostPlayerInfo);
      const toGuest = foundPayload(userId, hostView, guestPlayerInfo);
      toHost.player = hostPlayerInfo;
      toHost.me = hostPlayerInfo;
      toGuest.player = guestPlayerInfo;
      toGuest.me = guestPlayerInfo;

      socketManager.emitToUser(opponentEntry.user, "match_found", toHost);
      socketManager.emitToUser(userId, "match_found", toGuest);
      if (session) {
        socketManager.broadcastGameStartedToPlayers(session, room.roomCode);
      }

      return {
        matched: true,
        status: "matched",
        queueId: currentQueue._id,
        roomId: room._id,
        roomCode: room.roomCode,
        gameId,
        sessionId: gameId,
        matchId: gameId,
        player: guestPlayerInfo,
        me: guestPlayerInfo,
        players: [
          { playerId: String(opponentEntry.user), userId: String(opponentEntry.user), name: opponentUser.name, seat: 0, seatIndex: 0, color: "RED", isHost: true },
          { playerId: String(userId), userId: String(userId), name: user.name, seat: 1, seatIndex: 1, color: "GREEN", isHost: false },
        ],
        autoStarted: Boolean(session),
        gameMode,
        entryFee,
        prizePool: room.prizePool,
        opponent: hostView,
        you: guestPlayerInfo,
        state: toGuest.state,
        gameState: toGuest.state,
        userCoins: balance,
      };
    }

    // ==========================================
    // CASE B: No Opponent Available -> Enqueue Player
    // ==========================================
    const queueEntry = await MatchmakingQueue.create({
      user: userId,
      status: "waiting",
      entryFee,
      gameMode,
      maxPlayers: 2,
      queuedAt: new Date(),
      expiresAt,
      isEntryFeeDeducted: entryFee > 0,
    });

    socketManager.emitToUser(userId, "matchmaking_waiting", {
      status: "waiting",
      queueId: queueEntry._id,
      entryFee,
      gameMode,
      estimatedWaitSeconds: Math.floor(queueTimeoutSec / 2),
    });

    return {
      matched: false,
      status: "waiting",
      queueId: queueEntry._id,
      entryFee,
      gameMode,
      estimatedWaitSeconds: Math.floor(queueTimeoutSec / 2),
      expiresAt,
      userCoins: balance,
    };
  } catch (error) {
    if (entryFee > 0) {
      await safeRefund(userId, entryFee, "matchmaking error rollback");
    }
    throw error;
  }
};

// ------------------------------------------------------------------
// 2. Get Queue / Match Status
// ------------------------------------------------------------------
const getQueueStatus = async (userId) => {
  const latestQueue = await MatchmakingQueue.findOne({
    user: userId,
    status: { $in: ["waiting", "matched"] },
  }).sort({ createdAt: -1 });

  if (!latestQueue) {
    return { status: "idle" };
  }

  // If waiting but expired, trigger auto-expire and refund
  if (latestQueue.status === "waiting" && latestQueue.expiresAt <= new Date()) {
    const expired = await MatchmakingQueue.findOneAndUpdate(
      { _id: latestQueue._id, status: "waiting" },
      { $set: { status: "expired", expiredAt: new Date() } },
      { returnDocument: "after" }
    );
    if (expired && expired.entryFee > 0 && !expired.isRefunded) {
      await safeRefund(userId, expired.entryFee, "matchmaking queue expired");
      await MatchmakingQueue.updateOne({ _id: expired._id }, { $set: { isRefunded: true } });
    }
    return { status: "expired", message: "Matchmaking queue timed out." };
  }

  if (latestQueue.status === "waiting") {
    return {
      status: "waiting",
      queueId: latestQueue._id,
      entryFee: latestQueue.entryFee,
      gameMode: latestQueue.gameMode,
      queuedAt: latestQueue.queuedAt,
      expiresAt: latestQueue.expiresAt,
    };
  }

  // status === "matched" - only while that match is still alive (old matches must not keep
  // reporting "matched" forever and block the app from showing the home screen)
  const matchedRoom = latestQueue.matchedRoom
    ? await GameRoom.findById(latestQueue.matchedRoom).lean()
    : null;
  if (!matchedRoom || !ACTIVE_ROOM_STATUSES.includes(matchedRoom.status)) {
    return { status: "idle" };
  }
  const liveSession = await GameSession.findOne({ room: latestQueue.matchedRoom, status: "in_progress" });
  const isHost = matchedRoom ? String(matchedRoom.host) === String(userId) : false;
  const seatIndex = isHost ? 0 : 1;
  const color = isHost ? "RED" : "GREEN";
  const player = {
    userId: String(userId),
    playerId: String(userId),
    seatIndex,
    seat: seatIndex,
    color,
    isHost,
  };
  const baseState = liveSession ? socketManager.formatSessionState(liveSession) : null;
  const myGameState = baseState ? socketManager.viewerView(baseState, userId) : null;

  return {
    status: "matched",
    queueId: latestQueue._id,
    matchId: liveSession ? String(liveSession._id) : (latestQueue.matchedSession ? String(latestQueue.matchedSession) : null),
    gameId: liveSession ? String(liveSession._id) : (latestQueue.matchedSession ? String(latestQueue.matchedSession) : null),
    sessionId: liveSession ? String(liveSession._id) : (latestQueue.matchedSession ? String(latestQueue.matchedSession) : null),
    roomId: latestQueue.matchedRoom,
    roomCode: latestQueue.matchedRoomCode,
    gameMode: latestQueue.gameMode,
    entryFee: latestQueue.entryFee,
    player,
    me: player,
    players: baseState ? baseState.players : (matchedRoom?.players || []),
    gameState: myGameState,
    state: myGameState,
    opponent: latestQueue.opponent,
    matchedAt: latestQueue.matchedAt,
  };
};

// ------------------------------------------------------------------
// 3. Cancel Matchmaking Queue
// ------------------------------------------------------------------
const cancelQueue = async (userId) => {
  const cancelled = await MatchmakingQueue.findOneAndUpdate(
    { user: userId, status: "waiting" },
    { $set: { status: "cancelled", cancelledAt: new Date() } },
    { returnDocument: "after" }
  );

  if (!cancelled) {
    // Check if user was already matched
    const matched = await MatchmakingQueue.findOne({
      user: userId,
      status: "matched",
      createdAt: { $gt: new Date(Date.now() - 300000) }, // last 5 minutes
    });
    if (matched) {
      throw new AppError("Match has already been found. Cannot cancel.", 400, {
        data: { roomCode: matched.matchedRoomCode },
      });
    }
    throw new AppError("No active waiting queue entry found to cancel.", 404);
  }

  let refundedAmount = 0;
  if (cancelled.entryFee > 0 && !cancelled.isRefunded) {
    await safeRefund(userId, cancelled.entryFee, "matchmaking queue cancelled");
    await MatchmakingQueue.updateOne({ _id: cancelled._id }, { $set: { isRefunded: true } });
    refundedAmount = cancelled.entryFee;
  }

  socketManager.emitToUser(userId, "matchmaking_cancelled", {
    status: "cancelled",
    queueId: cancelled._id,
    refundedAmount,
  });

  return {
    status: "cancelled",
    queueId: cancelled._id,
    refundedAmount,
  };
};

// ------------------------------------------------------------------
// 4. Sweeper: Expire Stale Waiting Queue Entries
// ------------------------------------------------------------------
const sweepExpiredQueues = async (batchLimit = 100) => {
  const expiredEntries = await MatchmakingQueue.find({
    status: { $in: ["waiting", "searching"] },
    expiresAt: { $lt: new Date() },
  })
    .limit(batchLimit)
    .lean();

  let count = 0;
  for (const entry of expiredEntries) {
    const claimed = await MatchmakingQueue.findOneAndUpdate(
      { _id: entry._id, status: { $in: ["waiting", "searching"] } },
      { $set: { status: "expired", expiredAt: new Date() }, $unset: { location: "" } },
      { returnDocument: "after" }
    );
    if (claimed) {
      if (claimed.entryFee > 0 && !claimed.isRefunded) {
        await safeRefund(claimed.user, claimed.entryFee, "matchmaking queue expired");
        await MatchmakingQueue.updateOne({ _id: claimed._id }, { $set: { isRefunded: true } });
      }
      socketManager.emitToUser(claimed.user, "matchmaking_expired", {
        status: "expired",
        queueId: claimed._id,
        message: "Matchmaking timed out. No opponent found.",
      });
      count += 1;
    }
  }
  return count;
};

// ------------------------------------------------------------------
// 5. Nearby Matchmaking: Join Nearby Queue
// ------------------------------------------------------------------
const joinNearbyQueue = async (user, body = {}) => {
  const userId = user._id;
  const { latitude, longitude, accuracy, radiusKm } = validateLocationCoordinates(body);
  const entryFee = body.entryFee !== undefined && body.entryFee !== null ? Number(body.entryFee) : 0;
  const gameMode = body.mode ? body.mode.trim() : (body.gameMode ? body.gameMode.trim() : "twoPlayer");
  const maxPlayers = 2;

  // 1. Check if user is already in an active room
  const activeRoom = await GameRoom.findOne({
    "players.user": userId,
    status: { $in: ACTIVE_ROOM_STATUSES },
  });
  if (activeRoom) {
    throw new AppError(
      `You are already in an active room (${activeRoom.roomCode}). Please finish or leave it first.`,
      400,
      { data: { roomCode: activeRoom.roomCode } }
    );
  }

  // 2. Check if user is already in an active matchmaking queue
  const existingQueue = await MatchmakingQueue.findOne({
    user: userId,
    status: { $in: ["waiting", "searching"] },
    expiresAt: { $gt: new Date() },
  });
  if (existingQueue) {
    throw new AppError("You are already in the matchmaking queue.", 400, {
      data: { queueId: existingQueue._id },
    });
  }

  // 3. Deduct entry fee before claiming or enqueuing
  let balance = null;
  if (entryFee > 0) {
    balance = await payEntryFee(userId, entryFee, "nearby matchmaking queue");
  }

  const queueTimeoutSec = config.matchmaking?.queueTimeoutSeconds || 60;
  const expiresAt = new Date(Date.now() + queueTimeoutSec * 1000);
  const maxDistanceMeters = radiusKm * 1000;

  try {
    // 4. Atomic Search for nearby opponent:
    const query = {
      status: { $in: ["waiting", "searching"] },
      queueType: "nearby",
      user: { $ne: userId }, // NEVER match with self!
      entryFee,
      gameMode,
      maxPlayers,
      expiresAt: { $gt: new Date() },
      "location.coordinates": { $exists: true, $ne: [] },
    };

    let candidates = [];
    try {
      candidates = await MatchmakingQueue.find({
        ...query,
        location: {
          $nearSphere: {
            $geometry: {
              type: "Point",
              coordinates: [longitude, latitude],
            },
            $maxDistance: maxDistanceMeters,
          },
        },
      }).limit(10);
    } catch (_geoErr) {
      // Fallback for mock/in-memory environments without 2dsphere index:
      candidates = await MatchmakingQueue.find(query).limit(20);
    }

    // Filter candidates using precise Haversine distance and mutually satisfying radii
    let matchedCandidate = null;
    for (const c of candidates) {
      if (!c.location?.coordinates || c.location.coordinates.length < 2) continue;
      const cLon = c.location.coordinates[0];
      const cLat = c.location.coordinates[1];
      const distKm = haversineDistanceKm(latitude, longitude, cLat, cLon);
      const effectiveMaxDistKm = Math.min(radiusKm, c.radiusKm || radiusKm);

      if (distKm <= effectiveMaxDistKm) {
        // Atomically claim candidate
        const claimed = await MatchmakingQueue.findOneAndUpdate(
          {
            _id: c._id,
            status: { $in: ["waiting", "searching"] },
          },
          {
            $set: {
              status: "matched",
              matchedAt: new Date(),
            },
            $unset: {
              location: "", // Ephemeral: clear location coordinates upon match
            },
          },
          { returnDocument: "after" }
        );

        if (claimed) {
          matchedCandidate = claimed;
          break;
        }
      }
    }

    // ==========================================
    // CASE A: Match Found!
    // ==========================================
    if (matchedCandidate) {
      const opponentUser = await User.findById(matchedCandidate.user)
        .select("name avatar email")
        .lean();

      if (!opponentUser) {
        await safeRefund(userId, entryFee, "opponent user invalid");
        throw new AppError("Opponent could not be verified. Please try again.", 500);
      }

      // Generate room with Host = matchedCandidate (Seat 0, Red) and Guest = Current User (Seat 1, Green)
      let room = null;
      for (let attempt = 0; attempt < 5 && !room; attempt++) {
        try {
          room = await GameRoom.create({
            roomCode: generateRoomCode(),
            host: matchedCandidate.user,
            players: [
              {
                user: matchedCandidate.user,
                name: opponentUser.name,
                avatar: opponentUser.avatar || "",
                seatIndex: 0,
                color: "Red",
                isReady: true,
                isHost: true,
              },
              {
                user: userId,
                name: user.name,
                avatar: user.avatar || "",
                seatIndex: 1,
                color: "Green",
                isReady: true,
                isHost: false,
              },
            ],
            maxPlayers: 2,
            gameMode,
            entryFee,
            prizePool: entryFee * 2,
            status: "waiting",
          });
        } catch (err) {
          if (err.code !== 11000) throw err;
        }
      }

      if (!room) {
        await safeRefund(userId, entryFee, "room generation failed");
        throw new AppError("Failed to initialize match room. Please try again.", 500);
      }

      // Start the match session immediately
      let session = null;
      try {
        ({ session } = await gameService.startGame(matchedCandidate.user, room.roomCode));
      } catch (err) {
        logger.error("nearby_matchmaking_autostart_failed", { roomCode: room.roomCode, err });
      }

      const gameId = session ? String(session._id) : String(room._id);

      // Record Player 1 (Opponent) match details
      matchedCandidate.matchedRoom = room._id;
      matchedCandidate.matchedRoomCode = room.roomCode;
      matchedCandidate.matchedSession = session ? session._id : null;
      matchedCandidate.opponent = {
        user: userId,
        name: user.name,
        avatar: user.avatar || "",
      };
      await matchedCandidate.save();

      // Record Player 2 (Current user) matched queue entry (location unset for privacy)
      const currentQueue = await MatchmakingQueue.create({
        user: userId,
        queueType: "nearby",
        status: "matched",
        entryFee,
        gameMode,
        maxPlayers: 2,
        radiusKm,
        matchedRoom: room._id,
        matchedRoomCode: room.roomCode,
        matchedSession: session ? session._id : null,
        opponent: {
          user: opponentUser._id,
          name: opponentUser.name,
          avatar: opponentUser.avatar || "",
        },
        queuedAt: new Date(),
        matchedAt: new Date(),
        expiresAt,
        isEntryFeeDeducted: entryFee > 0,
      });

      if (session) {
        socketManager.joinUsersToSession([matchedCandidate.user, userId], session);
      }

      const baseState = session ? socketManager.formatSessionState(session) : null;
      const foundPayload = (viewerId, oppView, meView) => {
        const st = baseState ? socketManager.viewerView(baseState, viewerId) : null;
        return {
          status: "matched",
          matchId: gameId,
          gameId,
          sessionId: gameId,
          roomId: room._id,
          roomCode: room.roomCode,
          gameMode,
          entryFee,
          prizePool: room.prizePool,
          players: [
            { playerId: String(matchedCandidate.user), name: opponentUser.name, seat: 0, seatIndex: 0, color: "Red" },
            { playerId: String(userId), name: user.name, seat: 1, seatIndex: 1, color: "Green" },
          ],
          opponent: oppView,
          you: meView,
          state: st,
          gameState: st,
        };
      };

      const opponentView = {
        id: userId,
        playerId: String(userId),
        name: user.name,
        avatar: user.avatar || "",
        seat: 1,
        seatIndex: 1,
        color: "Green",
      };
      const hostView = {
        id: opponentUser._id,
        playerId: String(opponentUser._id),
        name: opponentUser.name,
        avatar: opponentUser.avatar || "",
        seat: 0,
        seatIndex: 0,
        color: "Red",
      };

      const hostPlayerInfo = { userId: String(matchedCandidate.user), playerId: String(matchedCandidate.user), seat: 0, seatIndex: 0, color: "RED", isHost: true };
      const guestPlayerInfo = { userId: String(userId), playerId: String(userId), seat: 1, seatIndex: 1, color: "GREEN", isHost: false };
      const toHost = foundPayload(matchedCandidate.user, opponentView, hostPlayerInfo);
      const toGuest = foundPayload(userId, hostView, guestPlayerInfo);
      toHost.player = hostPlayerInfo;
      toHost.me = hostPlayerInfo;
      toGuest.player = guestPlayerInfo;
      toGuest.me = guestPlayerInfo;

      // Emit real-time Socket.IO events to both players
      socketManager.emitToUser(matchedCandidate.user, "nearby_match_found", toHost);
      socketManager.emitToUser(userId, "nearby_match_found", toGuest);
      socketManager.emitToUser(matchedCandidate.user, "match_found", toHost);
      socketManager.emitToUser(userId, "match_found", toGuest);

      if (session) {
        socketManager.broadcastGameStartedToPlayers(session, room.roomCode);
      }

      return {
        matched: true,
        status: "matched",
        queueId: currentQueue._id,
        matchId: gameId,
        gameId,
        sessionId: gameId,
        roomId: room._id,
        roomCode: room.roomCode,
        gameMode,
        player: guestPlayerInfo,
        me: guestPlayerInfo,
        players: toGuest.players,
        opponent: hostView,
        you: guestPlayerInfo,
        state: toGuest.state,
        gameState: toGuest.state,
        userCoins: balance,
      };
    }

    // ==========================================
    // CASE B: No Opponent Found -> Enqueue User
    // ==========================================
    const queueEntry = await MatchmakingQueue.create({
      user: userId,
      queueType: "nearby",
      status: "searching",
      location: {
        type: "Point",
        coordinates: [longitude, latitude],
      },
      locationAccuracy: accuracy,
      radiusKm,
      searchRadiusMeters: maxDistanceMeters,
      entryFee,
      gameMode,
      maxPlayers: 2,
      queuedAt: new Date(),
      expiresAt,
      isEntryFeeDeducted: entryFee > 0,
    });

    socketManager.emitToUser(userId, "matchmaking_status", {
      status: "searching",
      queueId: queueEntry._id,
      radiusKm,
      gameMode,
      estimatedWaitSeconds: Math.floor(queueTimeoutSec / 2),
    });

    return {
      matched: false,
      status: "searching",
      queueId: queueEntry._id,
      radiusKm,
      gameMode,
      estimatedWaitSeconds: Math.floor(queueTimeoutSec / 2),
      expiresAt,
      userCoins: balance,
    };
  } catch (error) {
    if (entryFee > 0) {
      await safeRefund(userId, entryFee, "nearby matchmaking error rollback");
    }
    throw error;
  }
};

// ------------------------------------------------------------------
// 6. Nearby Matchmaking: Get Status
// ------------------------------------------------------------------
const getNearbyQueueStatus = async (userId) => {
  const latestQueue = await MatchmakingQueue.findOne({
    user: userId,
    queueType: "nearby",
    status: { $in: ["waiting", "searching", "matched"] },
  }).sort({ createdAt: -1 });

  if (!latestQueue) {
    return { status: "idle" };
  }

  // If waiting/searching but expired, trigger auto-expire
  if (["waiting", "searching"].includes(latestQueue.status) && latestQueue.expiresAt <= new Date()) {
    const expired = await MatchmakingQueue.findOneAndUpdate(
      { _id: latestQueue._id, status: { $in: ["waiting", "searching"] } },
      { $set: { status: "expired", expiredAt: new Date() }, $unset: { location: "" } },
      { returnDocument: "after" }
    );
    if (expired && expired.entryFee > 0 && !expired.isRefunded) {
      await safeRefund(userId, expired.entryFee, "nearby matchmaking queue expired");
      await MatchmakingQueue.updateOne({ _id: expired._id }, { $set: { isRefunded: true } });
    }
    return { status: "expired", message: "Matchmaking queue timed out." };
  }

  if (["waiting", "searching"].includes(latestQueue.status)) {
    return {
      status: "searching",
      queueId: latestQueue._id,
      radiusKm: latestQueue.radiusKm,
      gameMode: latestQueue.gameMode,
      queuedAt: latestQueue.queuedAt,
      expiresAt: latestQueue.expiresAt,
    };
  }

  // status === "matched"
  const matchedRoom = latestQueue.matchedRoom
    ? await GameRoom.findById(latestQueue.matchedRoom).lean()
    : null;
  if (!matchedRoom || !ACTIVE_ROOM_STATUSES.includes(matchedRoom.status)) {
    return { status: "idle" };
  }
  const liveSession = await GameSession.findOne({ room: latestQueue.matchedRoom, status: "in_progress" });
  const isHost = matchedRoom ? String(matchedRoom.host) === String(userId) : false;
  const seatIndex = isHost ? 0 : 1;
  const color = isHost ? "RED" : "GREEN";
  const player = {
    userId: String(userId),
    playerId: String(userId),
    seatIndex,
    seat: seatIndex,
    color,
    isHost,
  };
  const baseState = liveSession ? socketManager.formatSessionState(liveSession) : null;
  const myGameState = baseState ? socketManager.viewerView(baseState, userId) : null;

  return {
    status: "matched",
    queueId: latestQueue._id,
    matchId: liveSession ? String(liveSession._id) : (latestQueue.matchedSession ? String(latestQueue.matchedSession) : String(latestQueue.matchedRoom)),
    gameId: liveSession ? String(liveSession._id) : (latestQueue.matchedSession ? String(latestQueue.matchedSession) : String(latestQueue.matchedRoom)),
    sessionId: liveSession ? String(liveSession._id) : (latestQueue.matchedSession ? String(latestQueue.matchedSession) : String(latestQueue.matchedRoom)),
    roomId: latestQueue.matchedRoom,
    roomCode: latestQueue.matchedRoomCode,
    gameMode: latestQueue.gameMode,
    entryFee: latestQueue.entryFee,
    player,
    me: player,
    players: baseState ? baseState.players : (matchedRoom?.players || []),
    gameState: myGameState,
    state: myGameState,
    opponent: latestQueue.opponent,
    matchedAt: latestQueue.matchedAt,
  };
};

// ------------------------------------------------------------------
// 7. Nearby Matchmaking: Cancel / Leave Queue
// ------------------------------------------------------------------
const cancelNearbyQueue = async (userId) => {
  const cancelled = await MatchmakingQueue.findOneAndUpdate(
    { user: userId, queueType: "nearby", status: { $in: ["waiting", "searching"] } },
    { $set: { status: "cancelled", cancelledAt: new Date() }, $unset: { location: "" } },
    { returnDocument: "after" }
  );

  if (!cancelled) {
    const matched = await MatchmakingQueue.findOne({
      user: userId,
      queueType: "nearby",
      status: "matched",
      createdAt: { $gt: new Date(Date.now() - 300000) },
    });
    if (matched) {
      throw new AppError("Match has already been found. Cannot cancel.", 400, {
        data: { roomCode: matched.matchedRoomCode },
      });
    }
    throw new AppError("No active nearby matchmaking queue found to cancel.", 404);
  }

  let refundedAmount = 0;
  if (cancelled.entryFee > 0 && !cancelled.isRefunded) {
    await safeRefund(userId, cancelled.entryFee, "nearby matchmaking queue cancelled");
    await MatchmakingQueue.updateOne({ _id: cancelled._id }, { $set: { isRefunded: true } });
    refundedAmount = cancelled.entryFee;
  }

  socketManager.emitToUser(userId, "matchmaking_cancelled", {
    status: "cancelled",
    queueId: cancelled._id,
    refundedAmount,
  });

  return {
    status: "cancelled",
    queueId: cancelled._id,
    refundedAmount,
  };
};

// ------------------------------------------------------------------
// 8. Nearby Matchmaking: Update Location
// ------------------------------------------------------------------
const updateNearbyLocation = async (userId, body = {}) => {
  const { latitude, longitude, accuracy } = validateLocationCoordinates({
    latitude: body.latitude,
    longitude: body.longitude,
    accuracy: body.accuracy,
    radiusKm: config.matchmaking?.defaultRadiusKm || 5,
  });

  const updated = await MatchmakingQueue.findOneAndUpdate(
    { user: userId, queueType: "nearby", status: { $in: ["waiting", "searching"] } },
    {
      $set: {
        "location.coordinates": [longitude, latitude],
        locationAccuracy: accuracy,
        updatedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );

  if (!updated) {
    throw new AppError("No active nearby queue found to update location.", 404);
  }

  return {
    success: true,
    status: "searching",
    queueId: updated._id,
    updatedAt: updated.updatedAt,
  };
};

// ------------------------------------------------------------------
// 9. Admin Matchmaking Statistics (Safe - No coordinates exposed)
// ------------------------------------------------------------------
const getNearbyMatchmakingStats = async () => {
  const [searchingCount, totalQueued, matchesCreated, cancelledCount, expiredCount, waitStats] =
    await Promise.all([
      MatchmakingQueue.countDocuments({ queueType: "nearby", status: { $in: ["waiting", "searching"] } }),
      MatchmakingQueue.countDocuments({ status: { $in: ["waiting", "searching"] } }),
      MatchmakingQueue.countDocuments({ queueType: "nearby", status: "matched" }),
      MatchmakingQueue.countDocuments({ queueType: "nearby", status: "cancelled" }),
      MatchmakingQueue.countDocuments({ queueType: "nearby", status: "expired" }),
      MatchmakingQueue.aggregate([
        { $match: { queueType: "nearby", status: "matched", matchedAt: { $ne: null } } },
        { $project: { waitSeconds: { $divide: [{ $subtract: ["$matchedAt", "$queuedAt"] }, 1000] } } },
        { $group: { _id: null, avgWaitSeconds: { $avg: "$waitSeconds" } } },
      ]),
    ]);

  return {
    searchingUsersCount: searchingCount,
    totalQueuedUsers: totalQueued,
    matchesCreated,
    cancelledSearches: cancelledCount,
    expiredQueues: expiredCount,
    matchmakingErrors: 0,
    averageWaitTimeSeconds: waitStats.length > 0 ? Math.round(waitStats[0].avgWaitSeconds * 10) / 10 : 0,
  };
};

module.exports = {
  joinQueue,
  getQueueStatus,
  cancelQueue,
  sweepExpiredQueues,
  haversineDistanceKm,
  validateLocationCoordinates,
  joinNearbyQueue,
  getNearbyQueueStatus,
  cancelNearbyQueue,
  leaveNearbyQueue: cancelNearbyQueue,
  updateNearbyLocation,
  getNearbyMatchmakingStats,
};
