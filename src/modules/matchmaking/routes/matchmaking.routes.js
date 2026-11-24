"use strict";

const express = require("express");
const router = express.Router();

const { protect } = require("../../../../middleware/auth.middleware");
const { matchmakingLimiter } = require("../../../../middleware/rateLimit.middleware");
const {
  validateRequest,
  joinQueueValidation,
} = require("../validations/matchmaking.validation");
const {
  joinQueue,
  getQueueStatus,
  cancelQueue,
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

module.exports = router;
