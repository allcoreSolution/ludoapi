"use strict";

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../../config/env");
const logger = require("../../utils/logger");
const User = require("../modules/auth/models/User");
const GameSession = require("../modules/games/models/GameSession");
const gameService = require("../modules/games/services/game.service");
const engine = require("../modules/games/engine/ludoEngine");

let io = null;

const extractToken = (socket) => {
  const authHeader =
    socket.handshake.auth?.token ||
    socket.handshake.headers?.authorization ||
    socket.handshake.query?.token ||
    "";
  if (!authHeader) return "";
  const match = String(authHeader).trim().match(/^Bearer\s+(.+)$/i);
  return (match ? match[1] : authHeader).trim();
};

const formatSessionState = (session) => {
  if (!session) return null;
  const remainingMs = session.turnDeadline
    ? Math.max(0, new Date(session.turnDeadline).getTime() - Date.now())
    : 15000;

  let movableTokenIds = [];
  if (session.turnStatus === "WAITING_FOR_MOVE" && session.lastDiceValue) {
    const curPlayer = (session.players || []).find(
      (p) => String(p.user?._id || p.user) === String(session.currentTurnPlayer)
    );
    if (curPlayer) {
      try {
        movableTokenIds = engine.getMovableTokenIds(curPlayer.tokens, session.lastDiceValue);
      } catch (_) {}
    }
  }

  return {
    sessionId: String(session._id),
    roomCode: session.roomCode,
    gameMode: session.gameMode,
    status: session.status,
    stateVersion: session.__v || 0,
    turn: {
      userId: String(session.currentTurnPlayer),
      seatIndex: session.currentTurnSeat,
      status: session.turnStatus,
      diceValue: session.lastDiceValue,
      consecutiveSixes: session.consecutiveSixes || 0,
      remainingMs,
      movableTokenIds,
    },
    players: (session.players || []).map((p) => ({
      userId: String(p.user?._id || p.user),
      name: p.name,
      avatar: p.avatar || "",
      seatIndex: p.seatIndex,
      color: p.color,
      score: p.score || 0,
      hasSurrendered: Boolean(p.hasSurrendered),
      online: true,
      tokens: (p.tokens || []).map((t) => ({
        tokenId: t.tokenId,
        step: t.step,
        isHome: Boolean(t.isHome),
      })),
      rank: p.rank || null,
    })),
    winnerId: session.winner ? String(session.winner?._id || session.winner) : null,
  };
};

const init = (httpServer) => {
  if (io) return io;

  io = new Server(httpServer, {
    cors: {
      origin: config.cors.origins.length > 0 ? config.cors.origins : "*",
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingTimeout: 30000,
    pingInterval: 25000,
  });

  // JWT Authentication Middleware for Socket Connections
  io.use(async (socket, next) => {
    try {
      const token = extractToken(socket);
      if (!token) {
        return next(new Error("Authentication required. Please provide a valid token."));
      }

      let decoded;
      try {
        decoded = jwt.verify(token, config.jwt.secret, {
          algorithms: [config.jwt.algorithm],
        });
      } catch (_err) {
        return next(new Error("Invalid or expired token."));
      }

      if (!decoded || decoded.typ === "admin" || typeof decoded.id !== "string") {
        return next(new Error("Invalid token payload."));
      }

      const user = await User.findById(decoded.id)
        .select("name email username avatar isActive role")
        .lean();

      if (!user) {
        return next(new Error("User not found."));
      }
      if (!user.isActive) {
        return next(new Error("Account is inactive."));
      }

      socket.user = user;
      return next();
    } catch (err) {
      logger.error("socket_auth_error", { err });
      return next(new Error("Authentication error."));
    }
  });

  io.on("connection", (socket) => {
    const userId = String(socket.user._id);
    const userRoom = `user:${userId}`;
    socket.join(userRoom);

    logger.info("socket_connected", {
      socketId: socket.id,
      userId,
      name: socket.user.name,
    });

    // 1. Join Room Lobby
    socket.on("join_room", (data, ack) => {
      try {
        const roomCode = (data?.roomCode || "").trim().toUpperCase();
        if (!roomCode) {
          if (typeof ack === "function") ack({ ok: false, code: "BAD_REQUEST", message: "roomCode is required" });
          return;
        }
        socket.join(`room:${roomCode}`);
        io.to(`room:${roomCode}`).emit("player_joined", {
          roomCode,
          userId,
          name: socket.user.name,
        });
        if (typeof ack === "function") ack({ ok: true, roomCode });
      } catch (err) {
        logger.error("socket_join_room_error", { err: err.message, userId });
        if (typeof ack === "function") ack({ ok: false, code: "INTERNAL_ERROR", message: err.message });
      }
    });

    // 2. Leave Room Lobby
    socket.on("leave_room", (data, ack) => {
      try {
        const roomCode = (data?.roomCode || "").trim().toUpperCase();
        if (roomCode) {
          socket.leave(`room:${roomCode}`);
          io.to(`room:${roomCode}`).emit("player_left", {
            roomCode,
            userId,
          });
        }
        if (typeof ack === "function") ack({ ok: true });
      } catch (err) {
        if (typeof ack === "function") ack({ ok: false, message: err.message });
      }
    });

    // 3. Join Match Session (Session channel synchronization)
    socket.on("join_session", async (data, ack) => {
      try {
        const sessionId = data?.sessionId;
        if (!sessionId) {
          if (typeof ack === "function") ack({ ok: false, code: "BAD_REQUEST", message: "sessionId is required" });
          return;
        }
        socket.join(`session:${sessionId}`);
        const session = await GameSession.findById(sessionId);
        if (!session) {
          if (typeof ack === "function") ack({ ok: false, code: "NOT_FOUND", message: "Game session not found" });
          return;
        }
        const st = formatSessionState(session);
        io.to(`session:${sessionId}`).emit("player_reconnected", {
          sessionId: String(sessionId),
          userId,
        });
        if (typeof ack === "function") ack({ ok: true, data: { state: st } });
      } catch (err) {
        logger.error("socket_join_session_error", { err: err.message, userId });
        if (typeof ack === "function") ack({ ok: false, code: "INTERNAL_ERROR", message: err.message });
      }
    });

    // 4. Start Match
    socket.on("start_match", async (data, ack) => {
      try {
        const roomCode = (data?.roomCode || "").trim().toUpperCase();
        const { session } = await gameService.startGame(socket.user._id, roomCode);
        const st = formatSessionState(session);
        const payload = {
          roomCode,
          sessionId: String(session._id),
          session: st,
          state: st,
        };
        io.to(`room:${roomCode}`).emit("match_started", payload);
        if (typeof ack === "function") ack({ ok: true, data: payload });
      } catch (err) {
        logger.error("socket_start_match_error", { err: err.message, userId });
        if (typeof ack === "function") {
          ack({
            ok: false,
            code: err.statusCode === 403 ? "FORBIDDEN" : (err.statusCode === 404 ? "NOT_FOUND" : "BAD_REQUEST"),
            message: err.message,
          });
        }
      }
    });

    // 5. Server Authoritative Dice Roll
    const handleRollDice = async (data, ack) => {
      try {
        const sessionId = data?.sessionId;
        if (!sessionId) {
          if (typeof ack === "function") ack({ ok: false, code: "BAD_REQUEST", message: "sessionId is required" });
          return;
        }
        const { message, data: rollData } = await gameService.rollDice(socket.user._id, sessionId);
        const updatedSession = await GameSession.findById(sessionId);
        const st = formatSessionState(updatedSession);
        const payload = {
          sessionId: String(sessionId),
          playerId: String(socket.user._id),
          diceValue: rollData.diceValue,
          movableTokenIds: rollData.movableTokenIds || [],
          turnPassed: Boolean(rollData.turnPassed),
          threeSixes: Boolean(rollData.consecutiveSixes >= 3),
          turn: st.turn,
          state: st,
        };

        // Broadcast to BOTH players in real time
        io.to(`session:${sessionId}`).emit("dice_roll_result", payload);
        io.to(`session:${sessionId}`).emit("dice_rolled", payload);

        if (typeof ack === "function") ack({ ok: true, data: { ...rollData, state: st } });
      } catch (err) {
        logger.warn("socket_roll_dice_error", { err: err.message, userId });
        if (typeof ack === "function") {
          ack({
            ok: false,
            code: err.statusCode === 403 ? "FORBIDDEN" : (err.statusCode === 404 ? "NOT_FOUND" : "BAD_REQUEST"),
            message: err.message,
          });
        }
      }
    };

    socket.on("dice_roll_requested", handleRollDice);
    socket.on("roll_dice", handleRollDice);

    // 6. Real-Time Token Movement
    const handleMoveToken = async (data, ack) => {
      try {
        const sessionId = data?.sessionId;
        const tokenId = data?.tokenId;
        if (!sessionId || tokenId === undefined) {
          if (typeof ack === "function") {
            ack({ ok: false, code: "BAD_REQUEST", message: "sessionId and tokenId are required" });
          }
          return;
        }
        const { message, data: moveData } = await gameService.moveToken(socket.user._id, sessionId, tokenId);
        const updatedSession = await GameSession.findById(sessionId);
        const st = formatSessionState(updatedSession);
        const payload = {
          sessionId: String(sessionId),
          playerId: String(socket.user._id),
          move: moveData.move || { tokenId: Number(tokenId) },
          turn: st.turn,
          state: st,
        };

        // Broadcast token move to BOTH devices
        io.to(`session:${sessionId}`).emit("token_moved", payload);

        if (moveData.gameCompleted) {
          const finishedPayload = {
            sessionId: String(sessionId),
            winnerId: moveData.winner ? String(moveData.winner) : (updatedSession.winner ? String(updatedSession.winner) : null),
            ranking: updatedSession.players.map((p) => ({ userId: String(p.user), rank: p.rank })),
            state: st,
          };
          io.to(`session:${sessionId}`).emit("match_finished", finishedPayload);
        }

        if (typeof ack === "function") ack({ ok: true, data: { ...moveData, state: st } });
      } catch (err) {
        logger.warn("socket_move_token_error", { err: err.message, userId });
        if (typeof ack === "function") {
          ack({
            ok: false,
            code: err.statusCode === 403 ? "FORBIDDEN" : (err.statusCode === 404 ? "NOT_FOUND" : "BAD_REQUEST"),
            message: err.message,
          });
        }
      }
    };

    socket.on("token_move_requested", handleMoveToken);
    socket.on("move_token", handleMoveToken);

    // 7. Turn Timeout Handling
    socket.on("turn_timeout", async (data, ack) => {
      try {
        const sessionId = data?.sessionId;
        if (!sessionId) {
          if (typeof ack === "function") ack({ ok: false, message: "sessionId is required" });
          return;
        }
        const { gameCompleted, session } = await gameService.handleTurnTimeout(socket.user._id, sessionId);
        const st = formatSessionState(session);
        io.to(`session:${sessionId}`).emit("turn_timeout", {
          sessionId: String(sessionId),
          userId,
          state: st,
        });
        if (gameCompleted) {
          io.to(`session:${sessionId}`).emit("match_finished", {
            sessionId: String(sessionId),
            winnerId: session.winner ? String(session.winner) : null,
            ranking: session.players.map((p) => ({ userId: String(p.user), rank: p.rank })),
            state: st,
          });
        }
        if (typeof ack === "function") ack({ ok: true, data: { session: st } });
      } catch (err) {
        if (typeof ack === "function") ack({ ok: false, message: err.message });
      }
    });

    // 8. Surrender Match
    socket.on("surrender_match", async (data, ack) => {
      try {
        const sessionId = data?.sessionId;
        if (!sessionId) {
          if (typeof ack === "function") ack({ ok: false, message: "sessionId is required" });
          return;
        }
        const { gameCompleted, session } = await gameService.surrenderMatch(socket.user._id, sessionId);
        const st = formatSessionState(session);
        io.to(`session:${sessionId}`).emit("player_surrendered", {
          sessionId: String(sessionId),
          userId,
          state: st,
        });
        if (gameCompleted) {
          io.to(`session:${sessionId}`).emit("match_finished", {
            sessionId: String(sessionId),
            winnerId: session.winner ? String(session.winner) : null,
            ranking: session.players.map((p) => ({ userId: String(p.user), rank: p.rank })),
            state: st,
          });
        }
        if (typeof ack === "function") ack({ ok: true, data: { session: st } });
      } catch (err) {
        if (typeof ack === "function") ack({ ok: false, message: err.message });
      }
    });

    // Handle disconnecting to broadcast to all session rooms before leaving
    socket.on("disconnecting", () => {
      for (const room of socket.rooms) {
        if (room.startsWith("session:")) {
          const sid = room.replace("session:", "");
          socket.to(room).emit("player_disconnected", {
            channel: "session",
            id: sid,
            sessionId: sid,
            userId,
          });
        }
      }
    });

    socket.on("disconnect", (reason) => {
      logger.info("socket_disconnected", {
        socketId: socket.id,
        userId,
        reason,
      });
    });
  });

  return io;
};

const getIO = () => io;

/**
 * Emit an event to a specific user's private room across all their active socket connections.
 */
const emitToUser = (userId, event, payload) => {
  if (!io || !userId) return false;
  const userRoom = `user:${String(userId)}`;
  io.to(userRoom).emit(event, payload);
  return true;
};

/**
 * Emit an event to all participants in a game session room.
 */
const emitToSession = (sessionId, event, payload) => {
  if (!io || !sessionId) return false;
  io.to(`session:${String(sessionId)}`).emit(event, payload);
  return true;
};

/**
 * Emit an event to all participants in a game room lobby.
 */
const emitToRoom = (roomCode, event, payload) => {
  if (!io || !roomCode) return false;
  io.to(`room:${String(roomCode).toUpperCase()}`).emit(event, payload);
  return true;
};

const close = async () => {
  if (io) {
    await new Promise((resolve) => io.close(resolve));
    io = null;
  }
};

module.exports = {
  init,
  getIO,
  emitToUser,
  emitToSession,
  emitToRoom,
  formatSessionState,
  close,
};
