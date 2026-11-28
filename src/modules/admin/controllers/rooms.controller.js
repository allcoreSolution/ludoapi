"use strict";

const AppError = require("../../../../utils/AppError");
const asyncHandler = require("../../../../utils/asyncHandler");
const { qs, parsePagination, pageMeta, escapeRegex, dateRange } = require("../../../../utils/adminHelpers");
const GameRoom = require("../../rooms/models/GameRoom");
const GameSession = require("../../games/models/GameSession");
const roomService = require("../../rooms/services/room.service");
const auditService = require("../services/audit.service");
const config = require("../../../../config/env");
const logger = require("../../../../utils/logger");

const VALID_ROOM_STATUSES = ["waiting", "starting", "playing", "finished", "cancelled", "expired"];
const VALID_ROOM_MODES = ["twoPlayer", "threePlayer", "fourPlayer"];

/**
 * 1. GET /api/admin/rooms
 * List rooms with pagination, search, status/mode filtering, and date ranges.
 */
exports.listRooms = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};

  const status = qs(req.query.status);
  if (VALID_ROOM_STATUSES.includes(status)) filter.status = status;

  const mode = qs(req.query.mode);
  if (VALID_ROOM_MODES.includes(mode)) filter.gameMode = mode;

  const code = qs(req.query.roomCode || req.query.search).trim().toUpperCase().slice(0, 12);
  if (code) filter.roomCode = new RegExp(`^${escapeRegex(code)}`);

  const userId = qs(req.query.userId || req.query.playerId);
  if (userId) {
    filter.$or = [{ host: userId }, { "players.user": userId }];
  }

  const range = dateRange(req.query.from, req.query.to);
  if (range) filter.createdAt = range;

  const [total, rooms] = await Promise.all([
    GameRoom.countDocuments(filter),
    GameRoom.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("host", "name username email avatar")
      .populate("players.user", "name username email avatar")
      .lean(),
  ]);

  const shaped = rooms.map((r) => ({
    id: String(r._id),
    roomCode: r.roomCode,
    host: r.host ? { id: String(r.host._id || r.host), name: r.host.name, email: r.host.email } : null,
    status: r.status,
    gameMode: r.gameMode,
    maxPlayers: r.maxPlayers,
    playerCount: Array.isArray(r.players) ? r.players.length : 0,
    players: (r.players || []).map((p) => ({
      userId: String(p.user?._id || p.user),
      name: p.name || p.user?.name || "Player",
      seatIndex: p.seatIndex,
      color: p.color,
      isHost: p.isHost,
    })),
    entryFee: r.entryFee || 0,
    prizePool: r.prizePool || 0,
    expiresAt: r.expiresAt || null,
    cancelledReason: r.cancelledReason || null,
    settlement: r.settlement || null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));

  res.json({
    success: true,
    data: {
      rooms: shaped,
      pagination: pageMeta(page, limit, total),
    },
  });
});

/**
 * 2. GET /api/admin/rooms/:id
 * Retrieve detailed room metadata, linked session history, and settlement records.
 */
exports.getRoomDetail = asyncHandler(async (req, res) => {
  const idOrCode = req.params.id.trim();
  const isMongoId = /^[a-fA-F0-9]{24}$/.test(idOrCode);
  const filter = isMongoId ? { _id: idOrCode } : { roomCode: idOrCode.toUpperCase() };

  const room = await GameRoom.findOne(filter)
    .populate("host", "name username email avatar")
    .populate("players.user", "name username email avatar")
    .lean();

  if (!room) throw new AppError("Room not found", 404);

  let session = null;
  if (room.session || room.status === "playing" || room.status === "finished") {
    session = await GameSession.findOne({
      $or: [{ room: room._id }, { roomCode: room.roomCode }],
    })
      .select("-history.fullState")
      .slice("history", -100)
      .lean();
  }

  res.json({
    success: true,
    data: {
      room: {
        id: String(room._id),
        roomCode: room.roomCode,
        host: room.host,
        status: room.status,
        gameMode: room.gameMode,
        maxPlayers: room.maxPlayers,
        entryFee: room.entryFee,
        prizePool: room.prizePool,
        players: room.players,
        expiresAt: room.expiresAt,
        cancelledReason: room.cancelledReason,
        cancelledBy: room.cancelledBy,
        settlement: room.settlement,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
      },
      session: session
        ? {
            id: String(session._id),
            status: session.status,
            winner: session.winner,
            prizePool: session.prizePool,
            turnNumber: session.turnNumber,
            players: session.players,
            moveCount: Array.isArray(session.history) ? session.history.length : 0,
            recentMoves: (session.history || []).slice(-20),
            startedAt: session.startedAt,
            endedAt: session.endedAt,
          }
        : null,
    },
  });
});

/**
 * 3. POST /api/admin/rooms/:id/cancel
 * Force-cancel an active or waiting room, refunding all participants with audit log.
 */
exports.forceCancelRoom = asyncHandler(async (req, res) => {
  const reason = (req.body.reason || "force cancelled by administrator").trim();
  const room = await GameRoom.findById(req.params.id);
  if (!room) throw new AppError("Room not found", 404);

  if (room.status === "playing" || room.status === "finished") {
    throw new AppError("Cannot cancel a room where gameplay has already started or finished", 400);
  }
  if (room.status === "cancelled" || room.status === "expired") {
    return res.json({
      success: true,
      message: `Room is already ${room.status}`,
      data: { room },
    });
  }

  const cancelled = await roomService.cancelRoomAndRefund(room, reason, "cancelled", req.admin._id);

  await auditService.record(req, "admin_force_cancel_room", {
    targetType: "room",
    targetId: room._id,
    meta: {
      roomCode: room.roomCode,
      reason,
      playersCount: (room.players || []).length,
      refundedAmountEach: room.entryFee,
    },
  });

  res.json({
    success: true,
    message: "Room cancelled successfully and all entry fees refunded",
    data: { room: cancelled },
  });
});

/**
 * 4. POST /api/admin/rooms/:id/expire
 * Force-expire an inactive room with immediate refund and player notification.
 */
exports.forceExpireRoom = asyncHandler(async (req, res) => {
  const reason = (req.body.reason || "force expired by administrator").trim();
  const room = await GameRoom.findById(req.params.id);
  if (!room) throw new AppError("Room not found", 404);

  if (room.status !== "waiting" && room.status !== "starting") {
    throw new AppError(`Cannot expire room in status '${room.status}'`, 400);
  }

  const expired = await roomService.cancelRoomAndRefund(room, reason, "expired", req.admin._id);

  await auditService.record(req, "admin_force_expire_room", {
    targetType: "room",
    targetId: room._id,
    meta: {
      roomCode: room.roomCode,
      reason,
      refundedAmountEach: room.entryFee,
    },
  });

  res.json({
    success: true,
    message: "Room expired successfully and all entry fees refunded",
    data: { room: expired },
  });
});

/**
 * 5. GET /api/admin/analytics/rooms
 * Native database aggregations for room creation, joins, completions, commission, and payouts.
 */
exports.getRoomAnalytics = asyncHandler(async (req, res) => {
  const range = dateRange(req.query.from, req.query.to);
  const matchFilter = range ? { createdAt: range } : {};

  const [metrics] = await GameRoom.aggregate([
    { $match: matchFilter },
    {
      $facet: {
        statusBreakdown: [
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ],
        modeBreakdown: [
          { $group: { _id: "$gameMode", count: { $sum: 1 } } },
        ],
        financials: [
          {
            $group: {
              _id: null,
              totalRooms: { $sum: 1 },
              totalWagered: { $sum: { $multiply: ["$entryFee", { $size: "$players" }] } },
              settledCommission: { $sum: "$settlement.platformCommission" },
              settledPayouts: { $sum: "$settlement.winnerPayout" },
            },
          },
        ],
        topHosts: [
          { $group: { _id: "$host", roomsCreated: { $sum: 1 }, totalWagered: { $sum: "$prizePool" } } },
          { $sort: { roomsCreated: -1 } },
          { $limit: 10 },
          {
            $lookup: {
              from: "users",
              localField: "_id",
              foreignField: "_id",
              as: "user",
            },
          },
          { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
          {
            $project: {
              userId: "$_id",
              name: "$user.name",
              username: "$user.username",
              roomsCreated: 1,
              totalWagered: 1,
            },
          },
        ],
      },
    },
  ]);

  const statusMap = (metrics?.statusBreakdown || []).reduce((acc, curr) => {
    acc[curr._id] = curr.count;
    return acc;
  }, {});

  const fin = metrics?.financials?.[0] || { totalRooms: 0, totalWagered: 0, settledCommission: 0, settledPayouts: 0 };

  res.json({
    success: true,
    data: {
      summary: {
        totalRooms: fin.totalRooms,
        waitingRooms: statusMap.waiting || 0,
        activeMatches: statusMap.playing || 0,
        completedMatches: statusMap.finished || 0,
        cancelledRooms: statusMap.cancelled || 0,
        expiredRooms: statusMap.expired || 0,
        totalWageredCoins: fin.totalWagered || 0,
        totalPlatformCommission: fin.settledCommission || 0,
        totalWinnerPayouts: fin.settledPayouts || 0,
      },
      statusDistribution: statusMap,
      modeDistribution: (metrics?.modeBreakdown || []).reduce((acc, curr) => {
        acc[curr._id] = curr.count;
        return acc;
      }, {}),
      topHosts: metrics?.topHosts || [],
    },
  });
});

/**
 * 6. GET /api/admin/fraud/room-alerts
 * Non-intrusive fraud detection for repeated matchups, collusive forfeits, and anomalies.
 */
exports.getFraudRoomAlerts = asyncHandler(async (req, res) => {
  const since = new Date(Date.now() - 48 * 3600 * 1000); // Past 48 hours

  // 1. Detect repeated matches between the exact same pair of users
  const repeatedPairs = await GameRoom.aggregate([
    { $match: { createdAt: { $gte: since }, "players.1": { $exists: true } } },
    {
      $project: {
        roomCode: 1,
        players: "$players.user",
        status: 1,
        entryFee: 1,
        settlement: 1,
        createdAt: 1,
      },
    },
    { $unwind: "$players" },
    { $sort: { players: 1 } },
    {
      $group: {
        _id: "$_id",
        roomCode: { $first: "$roomCode" },
        userPair: { $push: "$players" },
        status: { $first: "$status" },
        entryFee: { $first: "$entryFee" },
        winner: { $first: "$settlement.winner" },
        createdAt: { $first: "$createdAt" },
      },
    },
    {
      $group: {
        _id: { $substr: ["$userPair", 0, 100] },
        players: { $first: "$userPair" },
        matchCount: { $sum: 1 },
        totalCoinsWagered: { $sum: { $multiply: ["$entryFee", 2] } },
        rooms: { $push: { roomCode: "$roomCode", winner: "$winner", createdAt: "$createdAt" } },
      },
    },
    { $match: { matchCount: { $gte: 4 } } },
    { $sort: { matchCount: -1 } },
    { $limit: 20 },
  ]);

  // Populate user information for the detected pairs
  const alerts = await Promise.all(
    repeatedPairs.map(async (pair) => {
      const User = require("../../auth/models/User");
      const users = await User.find({ _id: { $in: pair.players } }).select("name username email").lean();
      return {
        type: "FREQUENT_PAIR_MATCHUP",
        severity: pair.matchCount >= 8 ? "HIGH" : "MEDIUM",
        evidence: `Users played ${pair.matchCount} matches in 48 hours with ${pair.totalCoinsWagered} coins wagered.`,
        matchCount: pair.matchCount,
        totalWagered: pair.totalCoinsWagered,
        players: users.map((u) => ({ id: String(u._id), name: u.name, username: u.username, email: u.email })),
        recentRooms: (pair.rooms || []).slice(-5),
      };
    })
  );

  res.json({
    success: true,
    data: {
      alertCount: alerts.length,
      alerts,
    },
  });
});

/**
 * 7. GET /api/admin/settings/economy
 * Fetch configurable economy parameters.
 */
exports.getEconomySettings = asyncHandler(async (_req, res) => {
  res.json({
    success: true,
    data: {
      platformFeePercent: config.economy.platformFeePercent,
      roomWaitingTtlMinutes: config.economy.roomWaitingTtlMinutes,
      maxEntryFee: config.economy.maxEntryFee,
      signupBonusCoins: config.economy.signupBonusCoins,
      allowedEntryFeeSlabs: [0, 10, 50, 100, 250, 500, 1000, 2500, 5000],
      appLinks: {
        packageName: config.appLinks.packageName,
        playStoreUrl: config.appLinks.playStoreUrl,
        apkDownloadUrl: config.appLinks.apkDownloadUrl,
        inviteBaseUrl: config.appLinks.inviteBaseUrl,
      },
    },
  });
});

/**
 * 8. PATCH /api/admin/settings/economy
 * Update configurable economy parameters with strict validation.
 */
exports.updateEconomySettings = asyncHandler(async (req, res) => {
  const { platformFeePercent, roomWaitingTtlMinutes, maxEntryFee } = req.body;

  if (platformFeePercent !== undefined) {
    const fee = Number(platformFeePercent);
    if (!Number.isFinite(fee) || fee < 0 || fee > 50) {
      throw new AppError("platformFeePercent must be between 0 and 50%", 400);
    }
    config.economy.platformFeePercent = fee;
  }

  if (roomWaitingTtlMinutes !== undefined) {
    const ttl = Number(roomWaitingTtlMinutes);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 120) {
      throw new AppError("roomWaitingTtlMinutes must be an integer between 1 and 120 minutes", 400);
    }
    config.economy.roomWaitingTtlMinutes = ttl;
  }

  if (maxEntryFee !== undefined) {
    const maxFee = Number(maxEntryFee);
    if (!Number.isInteger(maxFee) || maxFee < 0) {
      throw new AppError("maxEntryFee must be a non-negative integer", 400);
    }
    config.economy.maxEntryFee = maxFee;
  }

  await auditService.record(req, "admin_update_economy_settings", {
    targetType: "settings",
    meta: {
      platformFeePercent: config.economy.platformFeePercent,
      roomWaitingTtlMinutes: config.economy.roomWaitingTtlMinutes,
      maxEntryFee: config.economy.maxEntryFee,
    },
  });

  res.json({
    success: true,
    message: "Economy settings updated successfully",
    data: {
      platformFeePercent: config.economy.platformFeePercent,
      roomWaitingTtlMinutes: config.economy.roomWaitingTtlMinutes,
      maxEntryFee: config.economy.maxEntryFee,
    },
  });
});
