"use strict";

const mongoose = require("mongoose");
const AppError = require("../../../../utils/AppError");
const asyncHandler = require("../../../../utils/asyncHandler");
const { qs, parsePagination, pageMeta, escapeRegex } = require("../../../../utils/adminHelpers");
const GameSession = require("../../games/models/GameSession");
const MatchmakingQueue = require("../../matchmaking/models/MatchmakingQueue");
const { MODE_NAMES } = require("../../games/engine/ludoEngine");
const socketManager = require("../../../sockets/socketManager");

// ------------------------------------------------------------------
// 1. GET /api/admin/online/live-matches
// ------------------------------------------------------------------
exports.getLiveMatches = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
  const filter = {};

  const status = qs(req.query.status);
  if (status && ["in_progress", "completed", "abandoned"].includes(status)) {
    filter.status = status;
  } else {
    // Default to active live matches
    filter.status = "in_progress";
  }

  const mode = qs(req.query.mode);
  if (mode && MODE_NAMES.includes(mode)) {
    filter.gameMode = mode;
  }

  const roomCode = qs(req.query.roomCode).trim().toUpperCase();
  if (roomCode) {
    filter.roomCode = new RegExp(`^${escapeRegex(roomCode)}`);
  }

  const [total, sessions] = await Promise.all([
    GameSession.countDocuments(filter),
    GameSession.find(filter)
      .sort({ startedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select("-history -players.tokens")
      .lean(),
  ]);

  const now = Date.now();
  const liveMatches = sessions.map((session) => {
    const elapsedSeconds = session.startedAt
      ? Math.max(0, Math.floor((now - new Date(session.startedAt).getTime()) / 1000))
      : Math.max(0, Math.floor((now - new Date(session.createdAt).getTime()) / 1000));

    const players = (session.players || []).map((p) => {
      const pid = p.user?._id ? String(p.user._id) : String(p.user);
      const online = socketManager.isUserOnline(pid);
      return {
        playerId: pid,
        displayName: p.name || "",
        avatar: p.avatar || "",
        seat: p.seatIndex !== undefined ? p.seatIndex : 0,
        color: p.color || "",
        score: p.score || 0,
        socketConnected: online,
        connectionStatus: online ? "online" : "offline",
        lastSeenAt: null, // explicit null: lastSeenAt is not tracked in player schema
      };
    });

    return {
      sessionId: String(session._id),
      roomCode: session.roomCode,
      mode: session.gameMode,
      status: session.status,
      entryFee: session.entryFee ?? 0,
      prizePool: session.prizePool ?? 0,
      createdAt: session.createdAt,
      startedAt: session.startedAt,
      elapsedSeconds,
      currentTurn: {
        playerId: session.currentTurnPlayer ? String(session.currentTurnPlayer) : null,
        seat: session.currentTurnSeat !== undefined ? session.currentTurnSeat : 0,
        turnStatus: session.turnStatus || "WAITING_FOR_ROLL",
        gamePhase: session.gamePhase || "waiting_for_roll",
        turnDeadline: session.turnDeadline || null,
      },
      diceValue: session.lastDiceValue ?? null,
      players,
    };
  });

  return res.status(200).json({
    success: true,
    data: {
      matches: liveMatches,
      pagination: pageMeta(page, limit, total),
    },
  });
});

// ------------------------------------------------------------------
// 2. GET /api/admin/online/live-matches/:sessionId
// ------------------------------------------------------------------
exports.getLiveMatchDetail = asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const isMongoId = mongoose.Types.ObjectId.isValid(sessionId);
  const query = isMongoId
    ? { _id: sessionId }
    : { roomCode: String(sessionId).trim().toUpperCase() };

  const session = await GameSession.findOne(query, { history: { $slice: -50 } }).lean();
  if (!session) {
    throw new AppError("Live match session not found", 404);
  }

  const now = Date.now();
  const elapsedSeconds = session.startedAt
    ? Math.max(0, Math.floor((now - new Date(session.startedAt).getTime()) / 1000))
    : Math.max(0, Math.floor((now - new Date(session.createdAt).getTime()) / 1000));

  let currentTurnRemainingTime = null;
  if (session.turnDeadline && session.status === "in_progress") {
    const diff = new Date(session.turnDeadline).getTime() - now;
    currentTurnRemainingTime = {
      remainingMs: Math.max(0, diff),
      remainingSeconds: Math.max(0, Math.ceil(diff / 1000)),
    };
  }

  const players = (session.players || []).map((p) => {
    const pid = p.user?._id ? String(p.user._id) : String(p.user);
    const online = socketManager.isUserOnline(pid);
    return {
      playerId: pid,
      displayName: p.name || "",
      avatar: p.avatar || "",
      seat: p.seatIndex !== undefined ? p.seatIndex : 0,
      color: p.color || "",
      score: p.score || 0,
      hasSurrendered: Boolean(p.hasSurrendered),
      socketConnected: online,
      connectionStatus: online ? "online" : "offline",
      lastSeenAt: null,
      tokens: (p.tokens || []).map((t) => ({
        tokenId: t.tokenId,
        step: t.step,
        isHome: Boolean(t.isHome),
      })),
    };
  });

  const moveHistory = (session.history || []).map((m) => {
    const pid = m.player ? String(m.player) : null;
    const p = pid ? players.find((x) => x.playerId === pid) : null;
    return {
      playerId: pid,
      player: p?.displayName || null,
      action: m.action,
      diceValue: m.diceValue ?? null,
      tokenId: m.tokenId ?? null,
      prevStep: m.prevStep ?? null,
      newStep: m.newStep ?? null,
      pointsEarned: m.pointsEarned || 0,
      timestamp: m.timestamp || null,
    };
  });

  return res.status(200).json({
    success: true,
    data: {
      match: {
        sessionId: String(session._id),
        roomCode: session.roomCode,
        mode: session.gameMode,
        status: session.status,
        entryFee: session.entryFee ?? 0,
        prizePool: session.prizePool ?? 0,
        startedAt: session.startedAt,
        createdAt: session.createdAt,
        lastStateUpdatedAt: session.updatedAt || session.createdAt,
        elapsedSeconds,
        turnNumber: session.turnNumber || 1,
        actionSequence: session.actionSequence || 0,
        currentTurnPlayer: session.currentTurnPlayer ? String(session.currentTurnPlayer) : null,
        currentTurnSeat: session.currentTurnSeat !== undefined ? session.currentTurnSeat : 0,
        turnStatus: session.turnStatus,
        gamePhase: session.gamePhase,
        diceState: {
          lastDiceValue: session.lastDiceValue ?? null,
          consecutiveSixes: session.consecutiveSixes || 0,
        },
        currentTurnRemainingTime,
        players,
        moveHistory,
      },
    },
  });
});

// ------------------------------------------------------------------
// 3. GET /api/admin/online/queues
// ------------------------------------------------------------------
exports.getQueueStats = asyncHandler(async (req, res) => {
  const activeQueues = await MatchmakingQueue.find({
    status: { $in: ["waiting", "searching"] },
  })
    .select("user queueType status entryFee gameMode maxPlayers createdAt")
    .lean();

  const now = Date.now();
  const statsByMode = {};
  for (const mode of MODE_NAMES) {
    statsByMode[mode] = {
      mode,
      queueCount: 0,
      oldestWaitingSeconds: 0,
      averageWaitingSeconds: 0,
      byQueueType: { standard: 0, nearby: 0 },
    };
  }

  const waitingDurationsByMode = {
    twoPlayer: [],
    threePlayer: [],
    fourPlayer: [],
  };

  for (const item of activeQueues) {
    const mode = statsByMode[item.gameMode] ? item.gameMode : "twoPlayer";
    statsByMode[mode].queueCount += 1;
    const type = item.queueType === "nearby" ? "nearby" : "standard";
    statsByMode[mode].byQueueType[type] = (statsByMode[mode].byQueueType[type] || 0) + 1;

    if (item.createdAt) {
      const waitSec = Math.max(0, Math.floor((now - new Date(item.createdAt).getTime()) / 1000));
      if (!waitingDurationsByMode[mode]) waitingDurationsByMode[mode] = [];
      waitingDurationsByMode[mode].push(waitSec);
    }
  }

  for (const mode of MODE_NAMES) {
    const durations = waitingDurationsByMode[mode] || [];
    if (durations.length > 0) {
      statsByMode[mode].oldestWaitingSeconds = Math.max(...durations);
      const sum = durations.reduce((acc, val) => acc + val, 0);
      statsByMode[mode].averageWaitingSeconds = Math.round(sum / durations.length);
    }
  }

  return res.status(200).json({
    success: true,
    data: {
      modes: Object.values(statsByMode),
      totalQueued: activeQueues.length,
      updatedAt: new Date(now),
    },
  });
});
