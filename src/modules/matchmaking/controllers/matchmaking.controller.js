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

// 4. Enter Nearby Matchmaking Queue
const joinNearbyQueue = asyncHandler(async (req, res) => {
  const result = await matchmakingService.joinNearbyQueue(req.user, req.body);
  const statusCode = result.matched ? 200 : 201;

  return res.status(statusCode).json({
    success: true,
    status: result.status,
    queueId: result.queueId,
    message: result.matched
      ? "Nearby match found! Room initialized."
      : "Searching for nearby opponents...",
    data: result,
  });
});

// 5. Get Nearby Matchmaking Status
const getNearbyStatus = asyncHandler(async (req, res) => {
  const status = await matchmakingService.getNearbyQueueStatus(req.user._id);

  return res.status(200).json({
    success: true,
    data: status,
  });
});

// 6. Leave / Cancel Nearby Matchmaking Queue
const leaveNearbyQueue = asyncHandler(async (req, res) => {
  const result = await matchmakingService.cancelNearbyQueue(req.user._id);

  return res.status(200).json({
    success: true,
    message: "Nearby matchmaking cancelled successfully.",
    data: result,
  });
});

// 7. Update Nearby Location
const updateNearbyLocation = asyncHandler(async (req, res) => {
  const result = await matchmakingService.updateNearbyLocation(req.user._id, req.body);

  return res.status(200).json({
    success: true,
    message: "Nearby location updated successfully.",
    data: result,
  });
});

// 8. Admin Nearby Matchmaking Stats (Safe - No coordinates exposed)
const getNearbyMatchmakingStats = asyncHandler(async (req, res) => {
  const stats = await matchmakingService.getNearbyMatchmakingStats();

  return res.status(200).json({
    success: true,
    data: stats,
  });
});

module.exports = {
  joinQueue,
  getQueueStatus,
  cancelQueue,
  joinNearbyQueue,
  getNearbyStatus,
  leaveNearbyQueue,
  cancelNearbyQueue: leaveNearbyQueue,
  updateNearbyLocation,
  getNearbyMatchmakingStats,
};
