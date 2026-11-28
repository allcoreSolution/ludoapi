"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const mongoose = require("mongoose");

const config = require("./config/env");
const requestLogger = require("./middleware/requestLogger.middleware");
const sanitize = require("./middleware/sanitize.middleware");
const notFound = require("./middleware/notFound.middleware");
const errorHandler = require("./middleware/error.middleware");
const { globalLimiter } = require("./middleware/rateLimit.middleware");

const authRoutes = require("./src/modules/auth/routes/auth.routes");
const userRoutes = require("./src/modules/users/routes/user.routes");
const roomRoutes = require("./src/modules/rooms/routes/room.routes");
const matchmakingRoutes = require("./src/modules/matchmaking/routes/matchmaking.routes");
const gameRoutes = require("./src/modules/games/routes/game.routes");
const leaderboardRoutes = require("./src/modules/leaderboard/routes/leaderboard.routes");
const rewardRoutes = require("./src/modules/rewards/routes/reward.routes");
const walletRoutes = require("./src/modules/wallet/routes/wallet.routes");
const adminRoutes = require("./src/modules/admin/routes/admin.routes");
const bannerRoutes = require("./src/modules/banners/routes/banner.routes");
const supportRoutes = require("./src/modules/support/routes/support.routes");

const app = express();

app.disable("x-powered-by");
// Needed so req.ip (rate limiting, logs) is the real client IP behind nginx / a PaaS proxy.
app.set("trust proxy", config.trustProxy);

// Normalize multiple slashes in URL (e.g. //api//wallet -> /api/wallet)
app.use((req, _res, next) => {
  if (req.url && req.url.includes("//")) {
    req.url = req.url.replace(/\/{2,}/g, "/");
  }
  next();
});

app.use(requestLogger);

// ==========================
// Security Middleware
// ==========================
app.use(helmet());

const configuredOrigins = (config.cors.origins || []).map((o) => o.replace(/\/+$/, "").toLowerCase());

const isOriginAllowed = (origin) => {
  // Mobile apps (Flutter APK/iOS) and server-to-server calls send no Origin header
  if (!origin) return true;

  const norm = origin.replace(/\/+$/, "").toLowerCase();

  // Wildcard configured in CLIENT_URL
  if (configuredOrigins.includes("*")) return true;

  // In non-production, if no origins configured, allow all
  if (!config.isProd && configuredOrigins.length === 0) return true;

  // Exact match with configured origins
  if (configuredOrigins.includes(norm)) return true;

  // Allow Render hosted domains (*.onrender.com) so Flutter admin panel works seamlessly
  if (norm.endsWith(".onrender.com")) return true;

  // Wildcard subdomain matching (e.g. *.yourdomain.com)
  for (const pattern of configuredOrigins) {
    if (pattern.startsWith("*.")) {
      const domainSuffix = pattern.slice(2);
      try {
        const urlObj = new URL(norm);
        if (urlObj.hostname.endsWith(domainSuffix)) return true;
      } catch {}
    }
  }

  return false;
};

app.use(
  cors({
    origin(origin, callback) {
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"],
    maxAge: 86400,
  })
);

app.use(globalLimiter);

// ==========================
// Body Parsers
// ==========================
app.use(
  express.json({
    limit: "10kb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
app.use(sanitize);

// ==========================
// Health Checks
// ==========================
// Liveness: "is the process up?"  (kept compatible with the old response)
const healthCheckHandler = (req, res) => {
  res.status(200).json({
    success: true,
    message: "Ludo Supreme Backend is Running",
    version: process.env.npm_package_version || "1.2.1",
  });
};
app.get("/", healthCheckHandler);
app.get("/health", healthCheckHandler);
app.get("/api/health", healthCheckHandler);

// Readiness: "can it serve traffic?"  Use this for load-balancer / orchestrator probes.
app.get("/ready", (req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({ success: dbUp, database: dbUp ? "up" : "down" });
});

// ==========================
// Room Invitation Landing Page & Android App Links
// ==========================
const { getInviteLandingPage } = require("./src/modules/rooms/controllers/room.controller");
const { roomCodeParamValidation, validateRequest } = require("./src/modules/rooms/validations/room.validation");
const { createRateLimiter } = require("./middleware/rateLimit.middleware");

const invitePageLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 60,
  message: "Too many room invitation requests. Please try again later.",
});

// Primary Android App Links & Invitation Route: /join/:roomCode
app.get(
  "/join/:roomCode",
  invitePageLimiter,
  roomCodeParamValidation,
  validateRequest,
  getInviteLandingPage
);
app.get("/join", invitePageLimiter, getInviteLandingPage);

// Backward-compatible alias: /invite/:roomCode
app.get(
  "/invite/:roomCode",
  invitePageLimiter,
  roomCodeParamValidation,
  validateRequest,
  getInviteLandingPage
);
app.get("/invite", invitePageLimiter, getInviteLandingPage);

// Android App Links verification endpoint (public, unauthenticated, valid JSON)
app.get("/.well-known/assetlinks.json", (_req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=86400");
  const rawFingerprints = process.env.ANDROID_SHA256_FINGERPRINTS || "";
  const fingerprints = rawFingerprints
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const packageName =
    process.env.ANDROID_PACKAGE_NAME ||
    config.appLinks?.packageName ||
    "com.allcore.ludo";

  return res.status(200).json([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ]);
});

// ==========================
// API Routes
// ==========================
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/rooms", roomRoutes);
app.use("/api/matchmaking", matchmakingRoutes);
app.use("/api/games", gameRoutes);
app.use("/api/leaderboard", leaderboardRoutes);
app.use("/api/rewards", rewardRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/banners", bannerRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/admin", adminRoutes);

// ==========================
// 404 + Global Error Handler
// ==========================
app.use(notFound);
app.use(errorHandler);

module.exports = app;
