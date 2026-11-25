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

const joinNearbyQueueValidation = [
  body("latitude")
    .exists({ checkFalsy: false })
    .withMessage("latitude is required")
    .isFloat({ min: -90, max: 90 })
    .withMessage("latitude must be a valid number between -90 and 90"),

  body("longitude")
    .exists({ checkFalsy: false })
    .withMessage("longitude is required")
    .isFloat({ min: -180, max: 180 })
    .withMessage("longitude must be a valid number between -180 and 180"),

  body("accuracy")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("accuracy must be a non-negative number in meters"),

  body("radiusKm")
    .optional()
    .isFloat({ min: config.matchmaking?.minRadiusKm || 0.5, max: config.matchmaking?.maxRadiusKm || 100 })
    .withMessage(
      `radiusKm must be a number between ${config.matchmaking?.minRadiusKm || 0.5} and ${
        config.matchmaking?.maxRadiusKm || 100
      }`
    ),

  body("mode")
    .optional()
    .isIn(MODE_NAMES)
    .withMessage("mode must be 'twoPlayer', 'threePlayer', or 'fourPlayer'"),

  body("gameMode")
    .optional()
    .isIn(MODE_NAMES)
    .withMessage("gameMode must be 'twoPlayer', 'threePlayer', or 'fourPlayer'"),

  body("entryFee")
    .optional()
    .isInt({ min: 0, max: config.economy.maxEntryFee })
    .withMessage(`entryFee must be a whole number between 0 and ${config.economy.maxEntryFee}`),
];

const updateNearbyLocationValidation = [
  body("latitude")
    .exists({ checkFalsy: false })
    .withMessage("latitude is required")
    .isFloat({ min: -90, max: 90 })
    .withMessage("latitude must be a valid number between -90 and 90"),

  body("longitude")
    .exists({ checkFalsy: false })
    .withMessage("longitude is required")
    .isFloat({ min: -180, max: 180 })
    .withMessage("longitude must be a valid number between -180 and 180"),

  body("accuracy")
    .optional()
    .isFloat({ min: 0 })
    .withMessage("accuracy must be a non-negative number in meters"),
];

module.exports = {
  validateRequest,
  joinQueueValidation,
  joinNearbyQueueValidation,
  updateNearbyLocationValidation,
};
