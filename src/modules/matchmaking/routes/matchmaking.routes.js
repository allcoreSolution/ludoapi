"use strict";

const express = require("express");
const router = express.Router();

const { protect } = require("../../../../middleware/auth.middleware");
const { matchmakingLimiter } = require("../../../../middleware/rateLimit.middleware");
const {
  validateRequest,
  joinQueueValidation,
  joinNearbyQueueValidation,
  updateNearbyLocationValidation,
} = require("../validations/matchmaking.validation");
const {
  joinQueue,
  getQueueStatus,
  cancelQueue,
  joinNearbyQueue,
  getNearbyStatus,
  leaveNearbyQueue,
  updateNearbyLocation,
  getNearbyMatchmakingStats,
} = require("../controllers/matchmaking.controller");

// 1. Enter Matchmaking Queue
router.post(
  "/queue",
  protect,
  matchmakingLimiter,
  joinQueueValidation,
  validateRequest,
  joinQueue
);

// 2. Get Matchmaking Status
router.get(
  "/status",
  protect,
  getQueueStatus
);

// 3. Cancel Matchmaking Queue
router.delete(
  "/queue",
  protect,
  matchmakingLimiter,
  cancelQueue
);

// ==========================================
// Nearby Location-Based Matchmaking Routes
// ==========================================

// 4. Join Nearby Matchmaking Queue
router.post(
  "/nearby/join",
  protect,
  matchmakingLimiter,
  joinNearbyQueueValidation,
  validateRequest,
  joinNearbyQueue
);

// 5. Leave / Cancel Nearby Matchmaking
router.post(
  "/nearby/leave",
  protect,
  matchmakingLimiter,
  leaveNearbyQueue
);

router.post(
  "/nearby/cancel",
  protect,
  matchmakingLimiter,
  leaveNearbyQueue
);

router.delete(
  "/nearby/queue",
  protect,
  matchmakingLimiter,
  leaveNearbyQueue
);

// 6. Get Nearby Matchmaking Status
router.get(
  "/nearby/status",
  protect,
  getNearbyStatus
);

// 7. Update Location During Active Searching
router.post(
  "/nearby/location",
  protect,
  matchmakingLimiter,
  updateNearbyLocationValidation,
  validateRequest,
  updateNearbyLocation
);

// 8. Nearby Matchmaking Stats (Safe Monitoring)
router.get(
  "/nearby/stats",
  protect,
  getNearbyMatchmakingStats
);

module.exports = router;
