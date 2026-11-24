"use strict";

const asyncHandler = require("../../../../utils/asyncHandler");
const gameService = require("../services/game.service");
const GameSession = require("../models/GameSession");
const socketManager = require("../../../sockets/socketManager");

// All business rules live in services/game.service.js and engine/ludoEngine.js.
// Controllers translate HTTP <-> service calls and broadcast real-time socket events.

// 1. Start / initialise a match
const startGameSession = asyncHandler(async (req, res) => {
  const roomCode = req.body.roomCode.trim().toUpperCase();
  const { session, created } = await gameService.startGame(req.user._id, roomCode);

  try {
    if (session) {
      const st = socketManager.formatSessionState(session);
      socketManager.emitToRoom(roomCode, "match_started", {
        roomCode,
        sessionId: String(session._id),
        session: st,
        state: st,
      });
    }
  } catch (_) {}

  return res.status(created ? 201 : 200).json({
    success: true,
    message: created ? "Game session started successfully" : "Game session already in progress",
    data: { session },
  });
});

// 2. Live state / reconnect (participants only)
const getGameSession = asyncHandler(async (req, res) => {
  const { session, remainingTimeSeconds } = await gameService.getSession(
    req.user._id,
    req.params.sessionId
  );
  return res.status(200).json({ success: true, data: { session, remainingTimeSeconds } });
});

// 3. Roll dice
const rollDice = asyncHandler(async (req, res) => {
  const { message, data } = await gameService.rollDice(req.user._id, req.params.sessionId);

  try {
    const updatedSession = await GameSession.findById(req.params.sessionId);
    if (updatedSession) {
      const st = socketManager.formatSessionState(updatedSession);
      const payload = {
        sessionId: String(req.params.sessionId),
        playerId: String(req.user._id),
        diceValue: data.diceValue,
        movableTokenIds: data.movableTokenIds || [],
        turnPassed: Boolean(data.turnPassed),
        threeSixes: Boolean(data.consecutiveSixes >= 3),
        turn: st.turn,
        state: st,
      };
      socketManager.emitToSession(req.params.sessionId, "dice_roll_result", payload);
      socketManager.emitToSession(req.params.sessionId, "dice_rolled", payload);
    }
  } catch (_) {}

  return res.status(200).json({ success: true, message, data });
});

// 4. Move token
const moveToken = asyncHandler(async (req, res) => {
  const { message, data } = await gameService.moveToken(
    req.user._id,
    req.params.sessionId,
    req.body.tokenId
  );

  try {
    const updatedSession = await GameSession.findById(req.params.sessionId);
    if (updatedSession) {
      const st = socketManager.formatSessionState(updatedSession);
      const payload = {
        sessionId: String(req.params.sessionId),
        playerId: String(req.user._id),
        move: data.move || { tokenId: Number(req.body.tokenId) },
        turn: st.turn,
        state: st,
      };
      socketManager.emitToSession(req.params.sessionId, "token_moved", payload);

      if (data.gameCompleted) {
        socketManager.emitToSession(req.params.sessionId, "match_finished", {
          sessionId: String(req.params.sessionId),
          winnerId: data.winner
            ? String(data.winner)
            : updatedSession.winner
            ? String(updatedSession.winner)
            : null,
          ranking: updatedSession.players.map((p) => ({ userId: String(p.user), rank: p.rank })),
          state: st,
        });
      }
    }
  } catch (_) {}

  return res.status(200).json({ success: true, message, data });
});

// 5. Turn timeout
const handleTurnTimeout = asyncHandler(async (req, res) => {
  const { gameCompleted, session } = await gameService.handleTurnTimeout(
    req.user._id,
    req.params.sessionId
  );

  try {
    if (session) {
      const st = socketManager.formatSessionState(session);
      socketManager.emitToSession(req.params.sessionId, "turn_timeout", {
        sessionId: String(req.params.sessionId),
        userId: String(req.user._id),
        state: st,
      });

      if (gameCompleted) {
        socketManager.emitToSession(req.params.sessionId, "match_finished", {
          sessionId: String(req.params.sessionId),
          winnerId: session.winner ? String(session.winner) : null,
          ranking: session.players.map((p) => ({ userId: String(p.user), rank: p.rank })),
          state: st,
        });
      }
    }
  } catch (_) {}

  return res.status(200).json({
    success: true,
    message: gameCompleted
      ? "Game completed due to player forfeits / timeouts"
      : "Turn timed out and passed to next player",
    data: gameCompleted ? { session, gameCompleted: true } : { session },
  });
});

// 6. Surrender
const surrenderMatch = asyncHandler(async (req, res) => {
  const { gameCompleted, session } = await gameService.surrenderMatch(
    req.user._id,
    req.params.sessionId
  );

  try {
    if (session) {
      const st = socketManager.formatSessionState(session);
      socketManager.emitToSession(req.params.sessionId, "player_surrendered", {
        sessionId: String(req.params.sessionId),
        userId: String(req.user._id),
        state: st,
      });

      if (gameCompleted) {
        socketManager.emitToSession(req.params.sessionId, "match_finished", {
          sessionId: String(req.params.sessionId),
          winnerId: session.winner ? String(session.winner) : null,
          ranking: session.players.map((p) => ({ userId: String(p.user), rank: p.rank })),
          state: st,
        });
      }
    }
  } catch (_) {}

  return res.status(200).json({
    success: true,
    message: gameCompleted ? "Match surrendered and ended" : "You have surrendered the match",
    data: gameCompleted ? { session, gameCompleted: true } : { session },
  });
});

// 7. Complete (only once the match clock has really run out)
const completeGameSession = asyncHandler(async (req, res) => {
  const session = await gameService.completeMatch(req.user._id, req.params.sessionId);
  return res.status(200).json({
    success: true,
    message: "Game session completed and prize distributed",
    data: { session },
  });
});

// 8. History
const getMyGameHistory = asyncHandler(async (req, res) => {
  const data = await gameService.getHistory(req.user._id, req.query.page, req.query.limit);
  return res.status(200).json({ success: true, data });
});

module.exports = {
  startGameSession,
  getGameSession,
  rollDice,
  moveToken,
  handleTurnTimeout,
  surrenderMatch,
  completeGameSession,
  getMyGameHistory,
};
