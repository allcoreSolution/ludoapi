"use strict";

const { body, validationResult } = require("express-validator");
const config = require("../../../../config/env");
const { MODE_NAMES } = require("../../games/engine/ludoEngine");

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

const joinQueueValidation = [
  body("entryFee")
    .optional()
    .isInt({ min: 0, max: config.economy.maxEntryFee })
    .withMessage(`entryFee must be a whole number between 0 and ${config.economy.maxEntryFee}`),

  body("gameMode")
    .optional()
    .isIn(MODE_NAMES)
    .withMessage("gameMode must be 'twoPlayer', 'threePlayer', or 'fourPlayer'"),
];

module.exports = {
  validateRequest,
  joinQueueValidation,
};
