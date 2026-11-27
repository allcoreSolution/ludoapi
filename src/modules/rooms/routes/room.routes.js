const express = require("express");

const router = express.Router();

const { protect } = require("../../../../middleware/auth.middleware");
const { createRateLimiter } = require("../../../../middleware/rateLimit.middleware");

const {
  createRoom,
  joinRoom,
  getRoomDetails,
  leaveRoom,
  checkRoomAvailability,
  getShareTemplate,
} = require("../controllers/room.controller");

const {
  validateRequest,
  createRoomValidation,
  joinRoomValidation,
  roomCodeParamValidation,
  shareTemplateValidation,
} = require("../validations/room.validation");

const roomCheckLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 60,
  message: "Too many room availability checks. Please slow down.",
});

// ==========================
// 1. Share Template API (Static & Dynamic Invite Message)
// Registered BEFORE /:roomCode to prevent collision
// ==========================
router.get(
  "/share-template",
  shareTemplateValidation,
  validateRequest,
  getShareTemplate
);

// ==========================
// 2. Room Availability Check (Public / Pre-join validation)
// Registered BEFORE /:roomCode to prevent collision
// ==========================
router.get(
  "/:roomCode/check",
  roomCheckLimiter,
  roomCodeParamValidation,
  validateRequest,
  checkRoomAvailability
);

// ==========================
// 3. Create New Game Room
// ==========================
router.post(
  "/create",
  protect,
  createRoomValidation,
  validateRequest,
  createRoom
);

// ==========================
// 4. Join Game Room by Code
// ==========================
router.post(
  "/join",
  protect,
  joinRoomValidation,
  validateRequest,
  joinRoom
);

// ==========================
// 5. Leave / Cancel Game Room
// ==========================
router.post(
  "/leave",
  protect,
  joinRoomValidation,
  validateRequest,
  leaveRoom
);

// ==========================
// 6. Get Room Details (Protected)
// ==========================
router.get(
  "/:roomCode",
  protect,
  roomCodeParamValidation,
  validateRequest,
  getRoomDetails
);

module.exports = router;