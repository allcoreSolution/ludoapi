const { body, param, validationResult } = require("express-validator");
const config = require("../../../../config/env");
const { MAX_PLAYERS_LIST, MODE_NAMES } = require("../../games/engine/ludoEngine");

// ==========================
// Validation Error Handler
// ==========================
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: "Validation Failed",
      errors: errors.array().map((error) => ({
        field: error.path,
        message: error.msg,
      })),
    });
  }

  next();
};

// ==========================
// Create Room Validation
// ==========================
const createRoomValidation = [
  body("maxPlayers")
    .optional()
    .isInt({ min: 2, max: 4 })
    .custom((val) => MAX_PLAYERS_LIST.includes(Number(val)))
    .withMessage("maxPlayers must be 2, 3, or 4"),

  body("gameMode")
    .optional()
    .isIn(MODE_NAMES)
    .withMessage("gameMode must be 'twoPlayer', 'threePlayer', or 'fourPlayer'"),

  body("entryFee")
    .optional()
    .isInt({ min: 0, max: config.economy.maxEntryFee })
    .withMessage(`entryFee must be a whole number between 0 and ${config.economy.maxEntryFee}`),
];

// ==========================
// Join Room Validation
// ==========================
const joinRoomValidation = [
  body("roomCode")
    .trim()
    .notEmpty()
    .withMessage("Room code is required")
    .isLength({ min: 6, max: 6 })
    .withMessage("Room code must be exactly 6 characters")
    .isAlphanumeric()
    .withMessage("Room code must contain only letters and numbers"),
];

// ==========================
// Room Code Param Validation
// ==========================
const roomCodeParamValidation = [
  param("roomCode")
    .trim()
    .notEmpty()
    .withMessage("Room code is required in parameter")
    .isLength({ min: 6, max: 6 })
    .withMessage("Room code must be exactly 6 characters")
    .isAlphanumeric()
    .withMessage("Room code must contain only letters and numbers"),
];

module.exports = {
  validateRequest,
  createRoomValidation,
  joinRoomValidation,
  roomCodeParamValidation,
};
