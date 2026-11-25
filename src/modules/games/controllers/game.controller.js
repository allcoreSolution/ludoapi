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
      socketManager.joinUsersToSession(session.players.map((p) => p.user?._id || p.user), session);
      const st = socketManager.formatSessionState(session);
      const payload = {
        roomId: roomCode,
        roomCode,
        gameId: String(session._id),
        sessionId: String(session._id),
        matchId: String(session._id),
        turnNumber: session.turnNumber || 1,
        stateVersion: session.actionSequence || session.__v || 0,
        actionSequence: session.actionSequence || session.__v || 0,
        gamePhase: session.gamePhase || "waiting_for_roll",
        phase: session.gamePhase || "waiting_for_roll",
        currentPlayerId: String(session.currentTurnPlayer),
        currentSeat: session.currentTurnSeat !== undefined ? session.currentTurnSeat : 0,
        players: st.players,
        tokens: st.tokens,
        session: st,
        state: st,
        gameState: st,
      };
      socketManager.emitToGame(session, "match_started", payload);
      socketManager.emitToGame(session, "game_started", payload);
      socketManager.emitToGame(session, "game_state", { state: st, gameState: st });
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
  const actionId = req.body?.actionId || null;
  const { message, data } = await gameService.rollDice(req.user._id, req.params.sessionId, { actionId });

  try {
    const updatedSession = await GameSession.findById(req.params.sessionId);
    if (updatedSession) {
      socketManager.joinUsersToSession(updatedSession.players.map((p) => p.user?._id || p.user), updatedSession);
      const st = socketManager.formatSessionState(updatedSession);
      const payload = {
        roomId: updatedSession.roomCode,
        roomCode: updatedSession.roomCode,
        gameId: String(req.params.sessionId),
        sessionId: String(req.params.sessionId),
        matchId: String(req.params.sessionId),
        playerId: String(req.user._id),
        actionId,
        turnNumber: updatedSession.turnNumber || 1,
        stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
        actionSequence: updatedSession.actionSequence || updatedSession.__v || 0,
        diceValue: data.diceValue,
        diceResult: data.diceValue,
        legalMoves: data.legalMoves || data.movableTokenIds || [],
        movableTokenIds: data.movableTokenIds || [],
        turnPassed: Boolean(data.turnPassed),
        threeSixes: Boolean(data.consecutiveSixes >= 3),
        gamePhase: updatedSession.gamePhase,
        phase: updatedSession.gamePhase,
        turn: st.turn,
        state: st,
        gameState: st,
      };
      socketManager.emitToGame(updatedSession, "dice_roll_result", payload);
      socketManager.emitToGame(updatedSession, "dice_rolled", payload);

      if (data.turnPassed) {
        socketManager.emitToGame(updatedSession, "turn_changed", {
          roomId: updatedSession.roomCode,
          roomCode: updatedSession.roomCode,
          gameId: String(req.params.sessionId),
          sessionId: String(req.params.sessionId),
          matchId: String(req.params.sessionId),
          currentPlayerId: String(updatedSession.currentTurnPlayer),
          currentTurnSeat: updatedSession.currentTurnSeat,
          currentSeat: updatedSession.currentTurnSeat,
          turnNumber: updatedSession.turnNumber || 1,
          stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
          actionSequence: updatedSession.actionSequence || updatedSession.__v || 0,
          actionId,
          getsExtraTurn: false,
          gamePhase: updatedSession.gamePhase,
          phase: updatedSession.gamePhase,
          turn: st.turn,
          state: st,
          gameState: st,
        });
      }
      socketManager.emitToGame(updatedSession, "game_state", { state: st, gameState: st });
    }
  } catch (_) {}

  return res.status(200).json({ success: true, message, data });
});

// 4. Move token
const moveToken = asyncHandler(async (req, res) => {
  const actionId = req.body?.actionId || null;
  const { message, data } = await gameService.moveToken(
    req.user._id,
    req.params.sessionId,
    req.body.tokenId,
    { actionId }
  );

  try {
    const updatedSession = await GameSession.findById(req.params.sessionId);
    if (updatedSession) {
      socketManager.joinUsersToSession(updatedSession.players.map((p) => p.user?._id || p.user), updatedSession);
      const st = socketManager.formatSessionState(updatedSession);
      const payload = {
        roomId: updatedSession.roomCode,
        roomCode: updatedSession.roomCode,
        gameId: String(req.params.sessionId),
        sessionId: String(req.params.sessionId),
        matchId: String(req.params.sessionId),
        playerId: String(req.user._id),
        actionId,
        turnNumber: updatedSession.turnNumber || 1,
        stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
        actionSequence: updatedSession.actionSequence || updatedSession.__v || 0,
        tokenId: Number(req.body.tokenId),
        move: data.move || { tokenId: Number(req.body.tokenId) },
        gamePhase: updatedSession.gamePhase,
        phase: updatedSession.gamePhase,
        turn: st.turn,
        state: st,
        gameState: st,
      };
      socketManager.emitToGame(updatedSession, "token_moved", payload);

      if (!data.gameCompleted) {
        socketManager.emitToGame(updatedSession, "turn_changed", {
          roomId: updatedSession.roomCode,
          roomCode: updatedSession.roomCode,
          gameId: String(req.params.sessionId),
          sessionId: String(req.params.sessionId),
          matchId: String(req.params.sessionId),
          currentPlayerId: String(updatedSession.currentTurnPlayer),
          currentTurnSeat: updatedSession.currentTurnSeat,
          currentSeat: updatedSession.currentTurnSeat,
          turnNumber: updatedSession.turnNumber || 1,
          stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
          actionSequence: updatedSession.actionSequence || updatedSession.__v || 0,
          actionId,
          getsExtraTurn: Boolean(data.move?.getsExtraTurn),
          gamePhase: updatedSession.gamePhase,
          phase: updatedSession.gamePhase,
          turn: st.turn,
          state: st,
          gameState: st,
        });
      }

      if (data.gameCompleted) {
        const finishedPayload = {
          roomId: updatedSession.roomCode,
          roomCode: updatedSession.roomCode,
          gameId: String(req.params.sessionId),
          sessionId: String(req.params.sessionId),
          matchId: String(req.params.sessionId),
          winnerId: data.winner
            ? String(data.winner)
            : updatedSession.winner
            ? String(updatedSession.winner)
            : null,
          ranking: updatedSession.players.map((p) => ({ userId: String(p.user), rank: p.rank })),
          gamePhase: "game_over",
          phase: "game_over",
          turnNumber: updatedSession.turnNumber || 1,
          stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
          state: st,
          gameState: st,
        };
        socketManager.emitToGame(updatedSession, "game_over", finishedPayload);
        socketManager.emitToGame(updatedSession, "match_finished", finishedPayload);
      }

      socketManager.emitToGame(updatedSession, "game_state", { state: st, gameState: st });
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
    // tells the table who missed, then match_finished OR turn_changed + game_state
    socketManager.broadcastTimeoutResult(session, gameCompleted);
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

// Online Match API: Create Match (POST /api/games/create)
const createMatch = asyncHandler(async (req, res) => {
  const result = await gameService.createMatch(req.user, req.body);
  return res.status(201).json({
    success: true,
    message: "Match created successfully",
    data: result,
  });
});

// Online Match API: Join Match (POST /api/games/join)
const joinMatch = asyncHandler(async (req, res) => {
  const result = await gameService.joinMatch(req.user, req.body.roomCode);

  try {
    if (result.session) {
      socketManager.joinUsersToSession(result.session.players.map((p) => p.user?._id || p.user), result.session);
      const st = socketManager.formatSessionState(result.session);
      const payload = {
        roomId: result.roomCode,
        roomCode: result.roomCode,
        gameId: String(result.session._id),
        sessionId: String(result.session._id),
        matchId: String(result.session._id),
        turnNumber: result.session.turnNumber || 1,
        stateVersion: result.session.actionSequence || result.session.__v || 0,
        actionSequence: result.session.actionSequence || result.session.__v || 0,
        gamePhase: result.session.gamePhase || "waiting_for_roll",
        phase: result.session.gamePhase || "waiting_for_roll",
        currentPlayerId: String(result.session.currentTurnPlayer),
        currentSeat: result.session.currentTurnSeat !== undefined ? result.session.currentTurnSeat : 0,
        players: st.players,
        tokens: st.tokens,
        session: st,
        state: st,
        gameState: st,
      };
      socketManager.emitToGame(result.session, "match_started", payload);
      socketManager.emitToGame(result.session, "game_started", payload);
      socketManager.emitToGame(result.session, "game_state", { state: st, gameState: st });
    }
  } catch (_) {}

  return res.status(200).json({
    success: true,
    message: result.session ? "Joined match. Game is starting!" : "Joined match successfully. Waiting for opponent.",
    data: result,
  });
});

// Online Match API: Get Game State (GET /api/games/:gameId)
const getGameState = asyncHandler(async (req, res) => {
  const state = await gameService.getAuthoritativeGameState(req.user._id, req.params.gameId);
  return res.status(200).json({
    success: true,
    data: state,
  });
});

// Resume: GET /api/games/active  (call after login / app start)
const getActiveGame = asyncHandler(async (req, res) => {
  const data = await gameService.getActiveGame(req.user._id);
  return res.status(200).json({ success: true, data });
});

// One-call "Play Online": POST /api/games/online/play
const playOnline = asyncHandler(async (req, res) => {
  const data = await gameService.playOnline(req.user, req.body);
  const status = data.resumed || data.matched ? 200 : 201;
  return res.status(status).json({
    success: true,
    message: data.resumed
      ? "You already have an online game in progress"
      : data.matched
      ? "Match found! Game started."
      : "Searching for an opponent...",
    data,
  });
});

// DELETE /api/games/online/play  (stop searching, entry fee refunded)
const cancelOnline = asyncHandler(async (req, res) => {
  const data = await gameService.cancelOnline(req.user._id);
  return res.status(200).json({ success: true, message: "Matchmaking cancelled", data });
});

// Online Match API: Reconnect Match (POST /api/games/:gameId/reconnect)
const reconnectMatch = asyncHandler(async (req, res) => {
  const state = await gameService.reconnectMatch(req.user._id, req.params.gameId);
  return res.status(200).json({
    success: true,
    message: "Reconnected to match successfully",
    data: state,
  });
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
  createMatch,
  joinMatch,
  getGameState,
  getActiveGame,
  playOnline,
  cancelOnline,
  reconnectMatch,
};
