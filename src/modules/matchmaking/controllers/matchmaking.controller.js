"use strict";

const asyncHandler = require("../../../../utils/asyncHandler");
const matchmakingService = require("../services/matchmaking.service");

// 1. Enter Matchmaking Queue
const joinQueue = asyncHandler(async (req, res) => {
  const result = await matchmakingService.joinQueue(req.user, req.body);
  const statusCode = result.matched ? 200 : 201;

  return res.status(statusCode).json({
    success: true,
    message: result.matched
      ? "Match found! Room initialized."
      : "Added to matchmaking queue. Waiting for an opponent.",
    data: result,
  });
});

// 2. Get Matchmaking Status
const getQueueStatus = asyncHandler(async (req, res) => {
  const status = await matchmakingService.getQueueStatus(req.user._id);

  return res.status(200).json({
    success: true,
    data: status,
  });
});

// 3. Cancel Matchmaking Queue
const cancelQueue = asyncHandler(async (req, res) => {
  const result = await matchmakingService.cancelQueue(req.user._id);

  return res.status(200).json({
    success: true,
    message: "Matchmaking queue cancelled successfully.",
    data: result,
  });
});

module.exports = {
  joinQueue,
  getQueueStatus,
  cancelQueue,
};
