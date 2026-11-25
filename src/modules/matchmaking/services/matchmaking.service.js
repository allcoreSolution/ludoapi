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

      const opponentView = { id: userId, name: user.name, avatar: user.avatar || "", seatIndex: 1, color: "Green" };
      const hostView = {
        id: opponentUser._id,
        name: opponentUser.name,
        avatar: opponentUser.avatar || "",
        seatIndex: 0,
        color: "Red",
      };

      // Emit real-time Socket.IO events to both players (each gets their own "me" block)
      const toHost = foundPayload(opponentEntry.user, opponentView, { seatIndex: 0, color: "Red" });
      const toGuest = foundPayload(userId, hostView, { seatIndex: 1, color: "Green" });
      socketManager.emitToUser(opponentEntry.user, "match_found", toHost);
      socketManager.emitToUser(userId, "match_found", toGuest);
      if (session) {
        socketManager.emitToUser(opponentEntry.user, "match_started", toHost);
        socketManager.emitToUser(userId, "match_started", toGuest);
      }

      return {
        matched: true,
        status: "matched",
        queueId: currentQueue._id,
        roomId: room._id,
        roomCode: room.roomCode,
        gameId,
        sessionId: gameId,
        autoStarted: Boolean(session),
        gameMode,
        entryFee,
        prizePool: room.prizePool,
        opponent: hostView,
        you: { seatIndex: 1, color: "Green" },
        state: toGuest.state,
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
    ? await GameRoom.findById(latestQueue.matchedRoom).select("status").lean()
    : null;
  if (!matchedRoom || !ACTIVE_ROOM_STATUSES.includes(matchedRoom.status)) {
    return { status: "idle" };
  }
  const liveSession = await GameSession.findOne({ room: latestQueue.matchedRoom, status: "in_progress" })
    .select("_id")
    .lean();

  return {
    status: "matched",
    queueId: latestQueue._id,
    gameId: liveSession ? String(liveSession._id) : null,
    sessionId: liveSession ? String(liveSession._id) : null,
    roomId: latestQueue.matchedRoom,
    roomCode: latestQueue.matchedRoomCode,
    gameMode: latestQueue.gameMode,
    entryFee: latestQueue.entryFee,
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
    status: "waiting",
    expiresAt: { $lt: new Date() },
  })
    .limit(batchLimit)
    .lean();

  let count = 0;
  for (const entry of expiredEntries) {
    const claimed = await MatchmakingQueue.findOneAndUpdate(
      { _id: entry._id, status: "waiting" },
      { $set: { status: "expired", expiredAt: new Date() } },
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

module.exports = {
  joinQueue,
  getQueueStatus,
  cancelQueue,
  sweepExpiredQueues,
};
