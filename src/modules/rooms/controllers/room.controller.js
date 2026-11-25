"use strict";

const asyncHandler = require("../../../../utils/asyncHandler");
const roomService = require("../services/room.service");
const socketManager = require("../../../sockets/socketManager");
const GameSession = require("../../games/models/GameSession");

const buildPlayerInfo = (players = [], userId, fallbackSeat = 0, fallbackHost = false) => {
  const p = players.find((item) => String(item.user?._id || item.user) === String(userId));
  if (p) {
    return {
      userId: String(userId),
      playerId: String(userId),
      seatIndex: p.seatIndex !== undefined ? p.seatIndex : fallbackSeat,
      seat: p.seatIndex !== undefined ? p.seatIndex : fallbackSeat,
      color: (p.color || (p.seatIndex === 0 ? "RED" : "GREEN")).toUpperCase(),
      isHost: Boolean(p.isHost !== undefined ? p.isHost : fallbackHost),
    };
  }
  return {
    userId: String(userId),
    playerId: String(userId),
    seatIndex: fallbackSeat,
    seat: fallbackSeat,
    color: fallbackSeat === 0 ? "RED" : "GREEN",
    isHost: Boolean(fallbackHost),
  };
};

// 1. Create New Game Room
const createRoom = asyncHandler(async (req, res) => {
  const { room, userCoins } = await roomService.createRoom(req.user, req.body);
  const playerInfo = buildPlayerInfo(room.players, req.user._id, 0, true);

  return res.status(201).json({
    success: true,
    message: "Game room created successfully",
    roomId: room.roomCode,
    roomCode: room.roomCode,
    matchId: null,
    player: playerInfo,
    players: room.players,
    gameState: null,
    data: {
      room,
      roomId: room.roomCode,
      roomCode: room.roomCode,
      matchId: null,
      player: playerInfo,
      players: room.players,
      gameState: null,
      userCoins,
    },
  });
});

// 2. Join Existing Game Room
const joinRoom = asyncHandler(async (req, res) => {
  const result = await roomService.joinRoom(req.user, req.body.roomCode);
  const room = result.room;
  const isHost = String(room.host) === String(req.user._id);
  const playerInfo = buildPlayerInfo(
    room.players,
    req.user._id,
    result.seatIndex !== undefined ? result.seatIndex : 1,
    isHost
  );

  let activeSession = null;
  try {
    activeSession = await GameSession.findOne({ room: room._id, status: "in_progress" });
  } catch (_) {}
  const baseState = activeSession ? socketManager.formatSessionState(activeSession) : null;
  const myGameState = baseState ? socketManager.viewerView(baseState, req.user._id) : null;

  try {
    const roomCode = req.body.roomCode.trim().toUpperCase();
    socketManager.emitToRoom(roomCode, "player_joined", {
      roomCode,
      roomId: roomCode,
      room: result.room,
      userId: String(req.user._id),
      playerId: String(req.user._id),
      name: req.user.name,
      assignedColor: playerInfo.color,
      color: playerInfo.color,
      seatIndex: playerInfo.seatIndex,
      seat: playerInfo.seatIndex,
      isHost: playerInfo.isHost,
      player: playerInfo,
    });
  } catch (_) {}

  return res.status(200).json({
    success: true,
    message: result.alreadyInRoom ? "You are already in this room" : "Joined game room successfully",
    roomId: room.roomCode,
    roomCode: room.roomCode,
    matchId: activeSession ? String(activeSession._id) : null,
    player: playerInfo,
    players: room.players,
    gameState: myGameState,
    data: {
      room: result.room,
      roomId: room.roomCode,
      roomCode: room.roomCode,
      matchId: activeSession ? String(activeSession._id) : null,
      player: playerInfo,
      players: room.players,
      assignedColor: playerInfo.color,
      seatIndex: playerInfo.seatIndex,
      userCoins: result.userCoins,
      gameState: myGameState,
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
