"use strict";

const asyncHandler = require("../../../../utils/asyncHandler");
const roomService = require("../services/room.service");
const socketManager = require("../../../sockets/socketManager");

// 1. Create New Game Room
const createRoom = asyncHandler(async (req, res) => {
  const { room, userCoins } = await roomService.createRoom(req.user, req.body);
  return res.status(201).json({
    success: true,
    message: "Game room created successfully",
    data: { room, userCoins },
  });
});

// 2. Join Existing Game Room
const joinRoom = asyncHandler(async (req, res) => {
  const result = await roomService.joinRoom(req.user, req.body.roomCode);

  try {
    const roomCode = req.body.roomCode.trim().toUpperCase();
    socketManager.emitToRoom(roomCode, "player_joined", {
      roomCode,
      room: result.room,
      userId: String(req.user._id),
      name: req.user.name,
      assignedColor: result.assignedColor,
      seatIndex: result.seatIndex,
    });
  } catch (_) {}

  if (result.alreadyInRoom) {
    return res.status(200).json({
      success: true,
      message: "You are already in this room",
      data: { room: result.room },
    });
  }
  return res.status(200).json({
    success: true,
    message: "Joined game room successfully",
    data: {
      room: result.room,
      assignedColor: result.assignedColor,
      seatIndex: result.seatIndex,
      userCoins: result.userCoins,
    },
  });
});

// 3. Get Room Details by Code
const getRoomDetails = asyncHandler(async (req, res) => {
  const room = await roomService.getRoomDetails(req.params.roomCode);
  return res.status(200).json({ success: true, data: { room } });
});

// 4. Leave / Cancel Game Room
const leaveRoom = asyncHandler(async (req, res) => {
  const result = await roomService.leaveRoom(req.user, req.body.roomCode);

  try {
    const roomCode = req.body.roomCode.trim().toUpperCase();
    if (result.hostCancelled) {
      socketManager.emitToRoom(roomCode, "room_cancelled", {
        roomCode,
        room: result.room,
      });
    } else {
      socketManager.emitToRoom(roomCode, "player_left", {
        roomCode,
        room: result.room,
        userId: String(req.user._id),
      });
    }
  } catch (_) {}

  if (result.hostCancelled) {
    return res.status(200).json({
      success: true,
      message: "Room cancelled by host. Entry fees refunded to all players.",
      data: { room: result.room },
    });
  }
  return res.status(200).json({
    success: true,
    message: "Left room successfully. Entry fee refunded.",
    data: { room: result.room, userCoins: result.userCoins },
  });
});

module.exports = { createRoom, joinRoom, getRoomDetails, leaveRoom };
