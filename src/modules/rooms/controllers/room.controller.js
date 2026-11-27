"use strict";

const asyncHandler = require("../../../../utils/asyncHandler");
const logger = require("../../../../utils/logger");
const roomService = require("../services/room.service");
const socketManager = require("../../../sockets/socketManager");
const GameSession = require("../../games/models/GameSession");

const buildPlayerInfo = (players = [], userId, fallbackSeat = 0, fallbackHost = false) => {
  const p = players.find((item) => String(item.user?._id || item.user || item.userId) === String(userId));
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
  const formattedRoom = socketManager.formatRoomPayload(room);

  return res.status(201).json({
    success: true,
    message: "Game room created successfully",
    roomId: room.roomCode,
    roomCode: room.roomCode,
    matchId: null,
    sessionId: null,
    player: playerInfo,
    players: formattedRoom ? formattedRoom.players : room.players,
    gameState: null,
    data: {
      room: formattedRoom || room,
      roomId: room.roomCode,
      roomCode: room.roomCode,
      matchId: null,
      sessionId: null,
      player: playerInfo,
      players: formattedRoom ? formattedRoom.players : room.players,
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
  // If the room has reached maximum players, automatically transition and start the match!
  if (room.players.length >= room.maxPlayers) {
    try {
      const gameService = require("../../games/services/game.service");
      const startResult = await gameService.startGame(room.host, room.roomCode);
      activeSession = startResult.session;
      room.status = "playing";

      socketManager.joinUsersToSession(
        activeSession.players.map((p) => p.user?._id || p.user),
        activeSession
      );
      socketManager.broadcastGameStartedToPlayers(activeSession, room.roomCode);
    } catch (err) {
      logger.warn("auto_start_game_on_full_room_failed", { err: err.message, roomCode: room.roomCode });
    }
  }

  if (!activeSession) {
    try {
      activeSession = await GameSession.findOne({ room: room._id, status: "in_progress" });
    } catch (_) {}
  }

  const baseState = activeSession ? socketManager.formatSessionState(activeSession) : null;
  const myGameState = baseState ? socketManager.viewerView(baseState, req.user._id) : null;
  const formattedRoom = socketManager.formatRoomPayload(room, activeSession);

  try {
    const roomCode = (room.roomCode || req.body.roomCode || "").trim().toUpperCase();
    socketManager.emitToRoom(roomCode, "player_joined", {
      roomCode,
      roomId: roomCode,
      room: formattedRoom,
      userId: String(req.user._id),
      playerId: String(req.user._id),
      name: req.user.name,
      assignedColor: playerInfo.color,
      color: playerInfo.color,
      seatIndex: playerInfo.seatIndex,
      seat: playerInfo.seatIndex,
      isHost: playerInfo.isHost,
      player: playerInfo,
      players: formattedRoom ? formattedRoom.players : room.players,
    });

    if (formattedRoom) {
      socketManager.emitToRoom(roomCode, "room_state", {
        roomCode,
        roomId: roomCode,
        room: formattedRoom,
        players: formattedRoom.players,
        status: formattedRoom.status,
        sessionId: formattedRoom.sessionId,
      });
    }
  } catch (_) {}

  return res.status(200).json({
    success: true,
    message: result.alreadyInRoom ? "You are already in this room" : "Joined game room successfully",
    roomId: room.roomCode,
    roomCode: room.roomCode,
    sessionId: activeSession ? String(activeSession._id) : null,
    matchId: activeSession ? String(activeSession._id) : null,
    gameId: activeSession ? String(activeSession._id) : null,
    player: playerInfo,
    players: formattedRoom ? formattedRoom.players : room.players,
    gameState: myGameState,
    data: {
      room: formattedRoom || result.room,
      roomId: room.roomCode,
      roomCode: room.roomCode,
      sessionId: activeSession ? String(activeSession._id) : null,
      matchId: activeSession ? String(activeSession._id) : null,
      gameId: activeSession ? String(activeSession._id) : null,
      player: playerInfo,
      players: formattedRoom ? formattedRoom.players : room.players,
      assignedColor: playerInfo.color,
      seatIndex: playerInfo.seatIndex,
      userCoins: result.userCoins,
      gameState: myGameState,
    },
  });
});

// 3. Get Room Details by Code
const getRoomDetails = asyncHandler(async (req, res) => {
  const result = await roomService.getRoomDetails(req.params.roomCode);
  const room = result.room || result;
  const session = result.session || null;

  const sessionId = session ? String(session._id) : null;
  const matchId = sessionId;
  const roomCode = room.roomCode;
  const roomId = roomCode;

  // Authenticated player identity if req.user is a participant
  const userId = req.user ? String(req.user._id) : null;
  const myPlayer = userId
    ? (room.players || []).find((p) => String(p.user?._id || p.user || p.userId) === userId)
    : null;
  const isHost = myPlayer
    ? Boolean(myPlayer.isHost !== undefined ? myPlayer.isHost : myPlayer.seatIndex === 0)
    : (userId && String(room.host?._id || room.host) === userId);
  const playerInfo = myPlayer
    ? {
        userId,
        playerId: userId,
        seatIndex: myPlayer.seatIndex,
        seat: myPlayer.seatIndex,
        color: (myPlayer.color || (myPlayer.seatIndex === 0 ? "RED" : "GREEN")).toUpperCase(),
        isHost,
      }
    : null;

  const baseState = session ? socketManager.formatSessionState(session) : null;
  const gameState = baseState && userId ? socketManager.viewerView(baseState, userId) : baseState;
  const formattedRoom = socketManager.formatRoomPayload(room, session);

  return res.status(200).json({
    success: true,
    roomId,
    roomCode,
    sessionId,
    matchId,
    player: playerInfo,
    me: playerInfo,
    players: formattedRoom ? formattedRoom.players : room.players,
    gameState,
    state: gameState,
    data: {
      room: formattedRoom || room,
      roomId,
      roomCode,
      sessionId,
      matchId,
      player: playerInfo,
      me: playerInfo,
      players: formattedRoom ? formattedRoom.players : room.players,
      gameState,
      state: gameState,
    },
  });
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

// 5. Check Room Availability (Public / Pre-join validation)
const checkRoomAvailability = asyncHandler(async (req, res) => {
  const result = await roomService.checkRoomAvailability(req.params.roomCode);
  const status = result.roomExists ? 200 : 404;
  return res.status(status).json(result);
});

// 6. Get Share Template & Dynamic Invite Message
const getShareTemplate = asyncHandler(async (req, res) => {
  const { roomCode, entryCoins, gameMode, inviteUrl } = req.query;
  const result = roomService.buildShareTemplate({
    roomCode,
    entryCoins,
    gameMode,
    inviteUrl,
    req,
  });
  return res.status(200).json(result);
});

// 7. Get Room Invitation Landing Page (HTML View with Deep Link)
const getInviteLandingPage = asyncHandler(async (req, res) => {
  const availability = await roomService.checkRoomAvailability(req.params.roomCode);
  const html = roomService.generateInviteHtml(availability, req);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const status = availability.roomExists ? 200 : 404;
  return res.status(status).send(html);
});

module.exports = {
  createRoom,
  joinRoom,
  getRoomDetails,
  leaveRoom,
  checkRoomAvailability,
  getShareTemplate,
  getInviteLandingPage,
};
