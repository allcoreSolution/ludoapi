"use strict";

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../../config/env");
const logger = require("../../utils/logger");
const User = require("../modules/auth/models/User");

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
  close,
};
