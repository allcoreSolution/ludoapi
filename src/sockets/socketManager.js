"use strict";

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../../config/env");
const logger = require("../../utils/logger");
const User = require("../modules/auth/models/User");
const GameSession = require("../modules/games/models/GameSession");
const gameService = require("../modules/games/services/game.service");
const engine = require("../modules/games/engine/ludoEngine");

let io = null;

// ------------------------------------------------------------------
// Presence: userId -> Set(socketId). A user can have several sockets (two tabs / reconnect
// overlap); they count as "online" while at least one is connected.
// ------------------------------------------------------------------
const presence = new Map();

/** @returns {boolean} true when this was the user's first live socket */
const addPresence = (userId, socketId) => {
  const key = String(userId);
  let set = presence.get(key);
  if (!set) {
    set = new Set();
    presence.set(key, set);
  }
  set.add(socketId);
  return set.size === 1;
};

/** @returns {boolean} true when that was the user's last live socket */
const removePresence = (userId, socketId) => {
  const key = String(userId);
  const set = presence.get(key);
  if (!set) return false;
  set.delete(socketId);
  if (set.size === 0) {
    presence.delete(key);
    return true;
  }
  return false;
};

const isUserOnline = (userId) => (presence.get(String(userId))?.size || 0) > 0;

/**
 * Every channel a client may have joined for one match. Emitting to this ARRAY in a single
 * call delivers each event once per socket (emitting to session: and game: separately made a
 * socket that joined both receive the event twice -> dice animation played twice).
 */
const gameRooms = (session, extraId) => {
  if (!session) return [];
  const sid = String(session._id || session.sessionId || session.gameId);
  const rooms = new Set([`session:${sid}`, `game:${sid}`]);
  if (session.room) rooms.add(`game:${String(session.room)}`); // createMatch returns roomId as gameId
  if (session.roomCode) {
    rooms.add(`room:${String(session.roomCode).toUpperCase()}`);
    rooms.add(`room:${String(session.roomCode)}`);
    rooms.add(`game:${String(session.roomCode).toUpperCase()}`);
  }
  if (extraId) {
    rooms.add(`game:${String(extraId)}`);
  }
  return [...rooms];
};

const joinSocketToSession = (socket, session) => {
  socket.join(gameRooms(session));
  if (session.roomCode) {
    socket.join(`room:${String(session.roomCode).toUpperCase()}`);
    socket.join(`room:${String(session.roomCode)}`);
  }
};

/** Server-side join: both players receive game events even if the app forgets to join_session. */
const joinUsersToSession = (userIds, session) => {
  if (!io || !session || !userIds) return false;
  const rooms = gameRooms(session);
  if (session.roomCode) {
    rooms.push(`room:${String(session.roomCode).toUpperCase()}`);
    rooms.push(`room:${String(session.roomCode)}`);
  }
  for (const uid of userIds) {
    const id = uid?._id ? String(uid._id) : String(uid);
    io.in(`user:${id}`).socketsJoin(rooms);
  }
  return true;
};

const extractToken = (socket) => {
  const authHeader =
    socket.handshake.auth?.token ||
    socket.handshake.headers?.authorization ||
    socket.handshake.query?.token ||
    "";
  if (!authHeader) return "";
  const match = String(authHeader).trim().match(/^Bearer\s+(.+)$/i);
  return (match ? match[1] : authHeader).trim();
};

const formatSessionState = (session) => {
  if (!session) return null;
  const remainingMs = session.turnDeadline
    ? Math.max(0, new Date(session.turnDeadline).getTime() - Date.now())
    : 15000;

  const phase =
    session.gamePhase ||
    (session.status === "completed"
      ? "game_over"
      : session.turnStatus === "WAITING_FOR_MOVE"
      ? "waiting_for_move"
      : "waiting_for_roll");

  let movableTokenIds = [];
  if (
    (phase === "waiting_for_move" || session.turnStatus === "WAITING_FOR_MOVE") &&
    session.lastDiceValue
  ) {
    const curPlayer = (session.players || []).find(
      (p) => String(p.user?._id || p.user) === String(session.currentTurnPlayer)
    );
    if (curPlayer) {
      try {
        movableTokenIds = engine.getMovableTokenIds(curPlayer.tokens, session.lastDiceValue);
      } catch (_) {}
    }
  }

  const roomCode = session.roomCode || "";
  const roomId = session.room ? String(session.room?._id || session.room) : roomCode;
  const matchId = String(session._id);

  const tokensMap = {};
  for (const p of session.players || []) {
    const pid = String(p.user?._id || p.user);
    tokensMap[pid] = (p.tokens || []).map((t) => ({
      tokenId: t.tokenId,
      step: t.step,
      isHome: Boolean(t.isHome),
    }));
  }

  const playersList = (session.players || []).map((p) => {
    const uid = String(p.user?._id || p.user);
    const online = isUserOnline(uid);
    return {
      userId: uid,
      playerId: uid,
      name: p.name,
      avatar: p.avatar || "",
      seat: p.seatIndex,
      seatIndex: p.seatIndex,
      color: p.color,
      score: p.score || 0,
      hasSurrendered: Boolean(p.hasSurrendered),
      online,
      connected: online,
      tokens: (p.tokens || []).map((t) => ({
        tokenId: t.tokenId,
        step: t.step,
        isHome: Boolean(t.isHome),
      })),
      rank: p.rank || null,
    };
  });

  return {
    roomId,
    roomCode,
    matchId,
    sessionId: matchId,
    gameId: matchId,
    gameMode: session.gameMode || "twoPlayer",
    status: session.status === "in_progress" ? "playing" : session.status,
    gameStatus: session.status === "in_progress" ? "playing" : session.status,
    gamePhase: phase,
    phase,
    turnNumber: session.turnNumber || 1,
    stateVersion: session.actionSequence || session.__v || 0,
    actionSequence: session.actionSequence || session.__v || 0,
    lastActionId: session.lastActionId || null,
    currentPlayerId: String(session.currentTurnPlayer),
    currentTurnPlayer: String(session.currentTurnPlayer),
    currentSeat: session.currentTurnSeat !== undefined ? session.currentTurnSeat : 0,
    currentTurnSeat: session.currentTurnSeat !== undefined ? session.currentTurnSeat : 0,
    diceValue: session.lastDiceValue || null,
    diceRolled: Boolean(session.lastDiceValue),
    legalMoves: movableTokenIds,
    movableTokenIds,
    tokens: tokensMap,
    turn: {
      userId: String(session.currentTurnPlayer),
      playerId: String(session.currentTurnPlayer),
      seat: session.currentTurnSeat !== undefined ? session.currentTurnSeat : 0,
      seatIndex: session.currentTurnSeat !== undefined ? session.currentTurnSeat : 0,
      status: session.turnStatus,
      phase,
      gamePhase: phase,
      diceValue: session.lastDiceValue,
      diceRolled: Boolean(session.lastDiceValue),
      consecutiveSixes: session.consecutiveSixes || 0,
      remainingMs,
      movableTokenIds,
      legalMoves: movableTokenIds,
    },
    players: playersList,
    winner: session.winner ? String(session.winner?._id || session.winner) : null,
    winnerId: session.winner ? String(session.winner?._id || session.winner) : null,
  };
};

/**
 * Adds a per-player "me" block to a formatSessionState() result so the app knows what THIS
 * player may do right now (roll button enabled? which tokens are tappable?). Pure function.
 */
const viewerView = (state, userId) => {
  if (!state) return state;
  const uid = String(userId);
  const mine = (state.players || []).find((p) => p.userId === uid || p.playerId === uid);
  if (!mine) return state;
  const live = state.status === "in_progress" || state.status === "playing";
  const isMyTurn = live && (state.turn.userId === uid || state.turn.playerId === uid) && !mine.hasSurrendered;
  const canRoll = isMyTurn && (state.gamePhase === "waiting_for_roll" || state.turn.status === "WAITING_FOR_ROLL");
  const canMove = isMyTurn && (state.gamePhase === "waiting_for_move" || state.turn.status === "WAITING_FOR_MOVE");
  const legalMoves = canMove ? (state.turn.legalMoves || state.turn.movableTokenIds || []) : [];

  return {
    ...state,
    me: {
      userId: uid,
      playerId: uid,
      seat: mine.seatIndex !== undefined ? mine.seatIndex : mine.seat,
      seatIndex: mine.seatIndex !== undefined ? mine.seatIndex : mine.seat,
      color: (mine.color || (mine.seatIndex === 0 ? "RED" : "GREEN")).toUpperCase(),
      isMyTurn,
      canRoll,
      canMove,
      movableTokenIds: legalMoves,
      legalMoves,
    },
  };
};

// ------------------------------------------------------------------
// In-Memory Per-Session Action Lock (prevents parallel actions / race conditions)
// ------------------------------------------------------------------
const sessionLocks = new Map();

const withSessionLock = async (sessionId, fn) => {
  if (!sessionId) return fn();
  const key = String(sessionId);
  const prev = sessionLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  sessionLocks.set(key, prev.then(() => current, () => current));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (sessionLocks.get(key) === current) {
      sessionLocks.delete(key);
    }
  }
};

// ------------------------------------------------------------------
// Broadcast helpers (shared by sockets, REST controllers and the sweeper)
// ------------------------------------------------------------------
const broadcastTurnChanged = (session, extra = {}) => {
  if (!io || !session) return false;
  const st = formatSessionState(session);
  io.to(gameRooms(session)).emit("turn_changed", {
    roomId: session.roomCode,
    roomCode: session.roomCode,
    gameId: String(session._id),
    sessionId: String(session._id),
    matchId: String(session._id),
    currentTurnPlayer: String(session.currentTurnPlayer),
    currentPlayerId: String(session.currentTurnPlayer),
    currentTurnSeat: session.currentTurnSeat !== undefined ? session.currentTurnSeat : 0,
    currentSeat: session.currentTurnSeat !== undefined ? session.currentTurnSeat : 0,
    turnNumber: session.turnNumber || 1,
    stateVersion: session.actionSequence || session.__v || 0,
    actionSequence: session.actionSequence || session.__v || 0,
    phase: session.gamePhase || (session.turnStatus === "WAITING_FOR_MOVE" ? "waiting_for_move" : "waiting_for_roll"),
    gamePhase: session.gamePhase || (session.turnStatus === "WAITING_FOR_MOVE" ? "waiting_for_move" : "waiting_for_roll"),
    turn: st.turn,
    state: st,
    gameState: st,
    ...extra,
  });
  return true;
};

const broadcastGameState = (session) => {
  if (!io || !session) return false;
  const st = formatSessionState(session);
  io.to(gameRooms(session)).emit("game_state", {
    roomId: session.roomCode,
    roomCode: session.roomCode,
    sessionId: String(session._id),
    matchId: String(session._id),
    gameId: String(session._id),
    stateVersion: session.actionSequence || session.__v || 0,
    actionSequence: session.actionSequence || session.__v || 0,
    currentTurnPlayer: String(session.currentTurnPlayer),
    currentPlayerId: String(session.currentTurnPlayer),
    currentTurnSeat: session.currentTurnSeat !== undefined ? session.currentTurnSeat : 0,
    turnNumber: session.turnNumber || 1,
    players: st.players,
    state: st,
    gameState: st,
  });
  return true;
};

const broadcastMatchFinished = (session) => {
  if (!io || !session) return false;
  const st = formatSessionState(session);
  const payload = {
    roomId: session.roomCode,
    roomCode: session.roomCode,
    gameId: String(session._id),
    sessionId: String(session._id),
    matchId: String(session._id),
    winnerId: session.winner ? String(session.winner?._id || session.winner) : null,
    reason: session.settlement?.reason || null,
    ranking: (session.players || []).map((p) => ({
      userId: String(p.user?._id || p.user),
      rank: p.rank || null,
      outcome: p.outcome || null,
      score: p.score || 0,
      prizeEarned: p.prizeEarned || 0,
    })),
    gamePhase: "game_over",
    turnNumber: session.turnNumber || 1,
    stateVersion: session.actionSequence || session.__v || 0,
    state: st,
    gameState: st,
  };
  io.to(gameRooms(session)).emit("game_over", payload);
  io.to(gameRooms(session)).emit("match_finished", payload);
  return true;
};

const broadcastGameStartedToPlayers = (session, roomCode) => {
  if (!io || !session) return false;
  const st = formatSessionState(session);
  const rCode = roomCode || session.roomCode;
  const matchId = String(session._id);
  const rooms = gameRooms(session);

  // 1. Dispatch tailored player identity to each authenticated player's private channel
  for (const p of session.players || []) {
    const uid = String(p.user?._id || p.user);
    const isHost = Boolean(p.isHost !== undefined ? p.isHost : p.seatIndex === 0);
    const me = {
      userId: uid,
      playerId: uid,
      seatIndex: p.seatIndex,
      seat: p.seatIndex,
      color: (p.color || (p.seatIndex === 0 ? "RED" : "GREEN")).toUpperCase(),
      isHost,
    };
    const myState = viewerView(st, uid);
    const playerPayload = {
      success: true,
      matchId,
      sessionId: matchId,
      gameId: matchId,
      roomId: rCode,
      roomCode: rCode,
      me,
      player: me,
      you: me,
      players: st.players,
      state: myState,
      gameState: myState,
      turnNumber: session.turnNumber || 1,
      stateVersion: session.actionSequence || session.__v || 0,
      actionSequence: session.actionSequence || session.__v || 0,
      gamePhase: session.gamePhase || "waiting_for_roll",
      phase: session.gamePhase || "waiting_for_roll",
      currentPlayerId: String(session.currentTurnPlayer),
      currentSeat: session.currentTurnSeat !== undefined ? session.currentTurnSeat : 0,
    };

    io.to(`user:${uid}`).emit("game_started", playerPayload);
    io.to(`user:${uid}`).emit("match_started", playerPayload);
    io.to(`user:${uid}`).emit("game_state", playerPayload);

    logger.info("game_started_player_dispatched", {
      matchId,
      roomId: rCode,
      userId: uid,
      assignedSeat: me.seatIndex,
      playerColor: me.color,
      isHost: me.isHost,
      currentTurnPlayer: String(session.currentTurnPlayer),
    });
  }

  // 2. Also emit shared room payload to table rooms
  const sharedPayload = {
    roomId: rCode,
    roomCode: rCode,
    gameId: matchId,
    sessionId: matchId,
    matchId: matchId,
    turnNumber: session.turnNumber || 1,
    stateVersion: session.actionSequence || session.__v || 0,
    actionSequence: session.actionSequence || session.__v || 0,
    gamePhase: session.gamePhase || "waiting_for_roll",
    phase: session.gamePhase || "waiting_for_roll",
    currentPlayerId: String(session.currentTurnPlayer),
    currentSeat: session.currentTurnSeat !== undefined ? session.currentTurnSeat : 0,
    players: st.players,
    tokens: st.tokens,
    session: st,
    state: st,
    gameState: st,
  };
  io.to(rooms).emit("match_started", sharedPayload);
  io.to(rooms).emit("game_started", sharedPayload);
  io.to(rooms).emit("game_state", { state: st, gameState: st });
  return true;
};

/**
 * One call for "a turn timed out" (client-triggered OR sweeper-triggered):
 * tells the table who missed, then either ends the match or announces the next turn.
 */
const broadcastTimeoutResult = (session, gameCompleted = false) => {
  if (!io || !session) return false;
  const last = (session.history || [])[(session.history || []).length - 1];
  const timedOutUserId = last && last.action === "TIMEOUT" && last.player ? String(last.player) : null;
  const st = formatSessionState(session);

  if (timedOutUserId) {
    const missed = (session.players || []).find((p) => String(p.user?._id || p.user) === timedOutUserId);
    io.to(gameRooms(session)).emit("turn_timeout", {
      gameId: String(session._id),
      sessionId: String(session._id),
      userId: timedOutUserId,
      missedTurns: missed ? missed.missedTurns : undefined,
      state: st,
    });
  }
  if (gameCompleted) broadcastMatchFinished(session);
  else {
    broadcastTurnChanged(session, { reason: "timeout" });
    broadcastGameState(session);
  }
  return true;
};

/** On (re)connect: put the socket back into its live match(es) and hand over the state. */
const resumeActiveSessions = async (socket, userId, announce) => {
  const sessions = await GameSession.find({ status: "in_progress", "players.user": userId }).limit(5);
  for (const s of sessions) {
    joinSocketToSession(socket, s);
    const st = formatSessionState(s);
    if (announce) {
      socket.to(`session:${s._id}`).emit("player_reconnected", {
        gameId: String(s._id),
        sessionId: String(s._id),
        matchId: String(s._id),
        roomId: s.roomCode,
        roomCode: s.roomCode,
        userId,
        playerId: userId,
        stateVersion: s.actionSequence || s.__v || 0,
        actionSequence: s.actionSequence || s.__v || 0,
        currentTurnPlayer: String(s.currentTurnPlayer),
        currentPlayerId: String(s.currentTurnPlayer),
        state: st,
        gameState: st,
      });
    }
    const mine = viewerView(st, userId);
    const playerObj = (s.players || []).find((p) => String(p.user?._id || p.user) === String(userId));
    const me = playerObj ? {
      userId: String(userId),
      playerId: String(userId),
      seatIndex: playerObj.seatIndex,
      seat: playerObj.seatIndex,
      color: (playerObj.color || (playerObj.seatIndex === 0 ? "RED" : "GREEN")).toUpperCase(),
      isHost: Boolean(playerObj.isHost !== undefined ? playerObj.isHost : playerObj.seatIndex === 0),
    } : null;

    logger.info("player_reconnected_session", {
      matchId: String(s._id),
      roomId: s.roomCode,
      userId: String(userId),
      socketId: socket.id,
      assignedSeat: me ? me.seatIndex : null,
      playerColor: me ? me.color : null,
      isHost: me ? me.isHost : null,
      currentTurnPlayer: String(s.currentTurnPlayer),
    });

    const resumePayload = {
      gameId: String(s._id),
      sessionId: String(s._id),
      matchId: String(s._id),
      roomCode: s.roomCode,
      roomId: s.roomCode,
      stateVersion: s.actionSequence || s.__v || 0,
      actionSequence: s.actionSequence || s.__v || 0,
      currentTurnPlayer: String(s.currentTurnPlayer),
      currentPlayerId: String(s.currentTurnPlayer),
      currentTurnSeat: s.currentTurnSeat !== undefined ? s.currentTurnSeat : 0,
      turnNumber: s.turnNumber || 1,
      me,
      player: me,
      players: st.players,
      state: mine,
      gameState: mine,
    };

    socket.emit("active_game", resumePayload);
    socket.emit("game_state", resumePayload);
  }
};

const init = (httpServer) => {
  if (io) return io;

  const configuredOrigins = (config.cors?.origins || []).map((o) => o.replace(/\/+$/, "").toLowerCase());

  io = new Server(httpServer, {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    allowUpgrades: true,
    cors: {
      origin(origin, callback) {
        // Mobile clients (Flutter Android/iOS) and server-to-server calls send no Origin header
        if (!origin) return callback(null, true);
        const norm = origin.replace(/\/+$/, "").toLowerCase();
        if (configuredOrigins.includes("*") || configuredOrigins.length === 0) return callback(null, true);
        if (configuredOrigins.includes(norm)) return callback(null, true);
        if (norm.endsWith(".onrender.com")) return callback(null, true);
        for (const pattern of configuredOrigins) {
          if (pattern.startsWith("*.")) {
            const domainSuffix = pattern.slice(2);
            try {
              const urlObj = new URL(norm);
              if (urlObj.hostname.endsWith(domainSuffix)) return callback(null, true);
            } catch {}
          }
        }
        return callback(null, true);
      },
      methods: ["GET", "POST", "OPTIONS"],
      credentials: true,
    },
    pingTimeout: 30000,
    pingInterval: 25000,
  });

  // JWT Authentication Middleware for Socket Connections
  io.use(async (socket, next) => {
    try {
      const token = extractToken(socket);
      if (!token) {
        return next(new Error("Authentication required. Please provide a valid token."));
      }

      let decoded;
      try {
        decoded = jwt.verify(token, config.jwt.secret, {
          algorithms: [config.jwt.algorithm],
        });
      } catch (_err) {
        return next(new Error("Invalid or expired token."));
      }

      if (!decoded || decoded.typ === "admin" || typeof decoded.id !== "string") {
        return next(new Error("Invalid token payload."));
      }

      const user = await User.findById(decoded.id)
        .select("name email username avatar isActive role")
        .lean();

      if (!user) {
        return next(new Error("User not found."));
      }
      if (!user.isActive) {
        return next(new Error("Account is inactive."));
      }

      socket.user = user;
      return next();
    } catch (err) {
      logger.error("socket_auth_error", { err });
      return next(new Error("Authentication error."));
    }
  });

  io.on("connection", (socket) => {
    const userId = String(socket.user._id);
    const userRoom = `user:${userId}`;
    socket.join(userRoom);
    const firstSocket = addPresence(userId, socket.id);
    resumeActiveSessions(socket, userId, firstSocket).catch((err) =>
      logger.warn("socket_resume_failed", { err: err.message, userId })
    );

    logger.info("socket_connected", {
      socketId: socket.id,
      userId,
      name: socket.user.name,
    });

    // 1. Join Room Lobby
    socket.on("join_room", async (data, ack) => {
      try {
        const roomCode = (data?.roomCode || data?.roomId || "").trim().toUpperCase();
        if (!roomCode) {
          if (typeof ack === "function") ack({ ok: false, code: "BAD_REQUEST", message: "roomCode is required" });
          return;
        }

        const GameRoom = require("../modules/rooms/models/GameRoom");
        const room = await GameRoom.findOne({ roomCode });
        const activeSession = await GameSession.findOne({
          $or: [{ roomCode }, ...(room ? [{ room: room._id }] : [])],
          status: "in_progress",
        });

        if (room) {
          const isParticipant = (room.players || []).some((p) => String(p.user?._id || p.user) === userId);
          if (!isParticipant) {
            if (typeof ack === "function") ack({ ok: false, code: "FORBIDDEN", message: "You are not a participant in this game room" });
            return;
          }
        } else if (activeSession) {
          const isParticipant = (activeSession.players || []).some((p) => String(p.user?._id || p.user) === userId);
          if (!isParticipant) {
            if (typeof ack === "function") ack({ ok: false, code: "FORBIDDEN", message: "You are not a participant in this game room" });
            return;
          }
        }

        socket.join(`room:${roomCode}`);
        io.to(`room:${roomCode}`).emit("player_joined", {
          roomCode,
          roomId: roomCode,
          userId,
          playerId: userId,
          name: socket.user.name,
          avatar: socket.user.avatar || "",
        });

        // If a game session is already in progress for this roomCode, join and sync immediately
        if (activeSession) {
          joinSocketToSession(socket, activeSession);
          const st = formatSessionState(activeSession);
          const myState = viewerView(st, userId);
          socket.emit("game_state", { state: myState, gameState: myState });
        }

        if (typeof ack === "function") ack({ ok: true, roomCode });
      } catch (err) {
        logger.error("socket_join_room_error", { err: err.message, userId });
        if (typeof ack === "function") ack({ ok: false, code: "INTERNAL_ERROR", message: err.message });
      }
    });

    // 2. Leave Room Lobby
    socket.on("leave_room", (data, ack) => {
      try {
        const roomCode = (data?.roomCode || data?.roomId || "").trim().toUpperCase();
        if (roomCode) {
          socket.leave(`room:${roomCode}`);
          io.to(`room:${roomCode}`).emit("player_left", {
            roomCode,
            roomId: roomCode,
            userId,
            playerId: userId,
          });
        }
        if (typeof ack === "function") ack({ ok: true });
      } catch (err) {
        if (typeof ack === "function") ack({ ok: false, message: err.message });
      }
    });

    // 3. Join Match Session (Session channel synchronization)
    const handleJoinSession = async (data, ack) => {
      try {
        const sid = data?.sessionId || data?.gameId || data?.matchId || data?.roomId || data?.roomCode;
        if (!sid) {
          if (typeof ack === "function") ack({ ok: false, code: "BAD_REQUEST", message: "sessionId or gameId is required" });
          return;
        }

        const session = await gameService.findSessionByGameId(sid);
        if (!session) {
          if (typeof ack === "function") ack({ ok: false, code: "NOT_FOUND", message: "Game session not found" });
          return;
        }

        const st = formatSessionState(session);
        const myPlayer = (session.players || []).find((p) => String(p.user?._id || p.user) === userId);
        if (!myPlayer) {
          if (typeof ack === "function") ack({ ok: false, code: "FORBIDDEN", message: "You are not a participant in this game session" });
          return;
        }

        joinSocketToSession(socket, session);
        joinUsersToSession(session.players.map((p) => p.user?._id || p.user), session);

        const me = {
          userId,
          playerId: userId,
          seatIndex: myPlayer.seatIndex,
          seat: myPlayer.seatIndex,
          color: (myPlayer.color || (myPlayer.seatIndex === 0 ? "RED" : "GREEN")).toUpperCase(),
          isHost: Boolean(myPlayer.isHost !== undefined ? myPlayer.isHost : myPlayer.seatIndex === 0),
        };
        const myState = viewerView(st, userId);

        logger.info("player_joined_session", {
          matchId: String(session._id),
          roomId: session.roomCode,
          userId,
          socketId: socket.id,
          assignedSeat: me ? me.seatIndex : null,
          playerColor: me ? me.color : null,
          isHost: me ? me.isHost : null,
          currentTurnPlayer: String(session.currentTurnPlayer),
        });

        const joinPayload = {
          roomId: session.roomCode,
          roomCode: session.roomCode,
          gameId: String(session._id),
          sessionId: String(session._id),
          matchId: String(session._id),
          userId,
          playerId: userId,
          name: socket.user.name,
          currentTurnPlayer: String(session.currentTurnPlayer),
          currentPlayerId: String(session.currentTurnPlayer),
          currentTurnSeat: session.currentTurnSeat !== undefined ? session.currentTurnSeat : 0,
          turnNumber: session.turnNumber || 1,
          stateVersion: session.actionSequence || session.__v || 0,
          actionSequence: session.actionSequence || session.__v || 0,
          state: st,
          gameState: st,
        };

        const rooms = gameRooms(session, data?.gameId);
        io.to(rooms).emit("player_reconnected", joinPayload);
        socket.emit("game_state", {
          matchId: String(session._id),
          sessionId: String(session._id),
          gameId: String(session._id),
          roomId: session.roomCode,
          roomCode: session.roomCode,
          stateVersion: session.actionSequence || session.__v || 0,
          actionSequence: session.actionSequence || session.__v || 0,
          currentTurnPlayer: String(session.currentTurnPlayer),
          currentPlayerId: String(session.currentTurnPlayer),
          currentTurnSeat: session.currentTurnSeat !== undefined ? session.currentTurnSeat : 0,
          turnNumber: session.turnNumber || 1,
          me,
          player: me,
          players: st.players,
          state: myState,
          gameState: myState,
        });

        if (typeof ack === "function") {
          ack({
            ok: true,
            data: {
              matchId: String(session._id),
              sessionId: String(session._id),
              roomId: session.roomCode,
              roomCode: session.roomCode,
              me,
              player: me,
              seatIndex: me?.seatIndex,
              color: me?.color,
              players: st.players,
              state: myState,
              gameState: myState,
            },
          });
        }
      } catch (err) {
        logger.error("socket_join_session_error", { err: err.message, userId });
        if (typeof ack === "function") ack({ ok: false, code: "INTERNAL_ERROR", message: err.message });
      }
    };

    socket.on("join_session", handleJoinSession);
    socket.on("join_game", handleJoinSession);

    // 4. Start Match
    socket.on("start_match", async (data, ack) => {
      try {
        const roomCode = (data?.roomCode || data?.roomId || "").trim().toUpperCase();
        const { session } = await gameService.startGame(socket.user._id, roomCode);
        joinUsersToSession(session.players.map((p) => p.user?._id || p.user), session);
        joinSocketToSession(socket, session);

        broadcastGameStartedToPlayers(session, roomCode);

        const st = formatSessionState(session);
        const myPlayer = (session.players || []).find((p) => String(p.user?._id || p.user) === userId);
        const me = {
          userId,
          playerId: userId,
          seatIndex: myPlayer ? myPlayer.seatIndex : 0,
          seat: myPlayer ? myPlayer.seatIndex : 0,
          color: (myPlayer?.color || "RED").toUpperCase(),
          isHost: Boolean(myPlayer?.seatIndex === 0),
        };
        const myState = viewerView(st, userId);
        const ackPayload = {
          matchId: String(session._id),
          sessionId: String(session._id),
          gameId: String(session._id),
          roomId: roomCode,
          roomCode,
          me,
          player: me,
          seatIndex: me.seatIndex,
          color: me.color,
          players: st.players,
          tokens: st.tokens,
          session: st,
          state: myState,
          gameState: myState,
        };

        if (typeof ack === "function") ack({ ok: true, data: ackPayload });
      } catch (err) {
        logger.error("socket_start_match_error", { err: err.message, userId });
        socket.emit("game_error", { code: "START_FAILED", message: err.message });
        if (typeof ack === "function") {
          ack({
            ok: false,
            code: err.statusCode === 403 ? "FORBIDDEN" : (err.statusCode === 404 ? "NOT_FOUND" : "BAD_REQUEST"),
            message: err.message,
          });
        }
      }
    });

    // 5. Server Authoritative Dice Roll
    const handleRollDice = async (data, ack) => {
      const sid = data?.sessionId || data?.gameId || data?.matchId || data?.roomId || data?.roomCode;
      if (!sid) {
        if (typeof ack === "function") ack({ ok: false, code: "BAD_REQUEST", message: "sessionId or gameId is required" });
        return;
      }

      await withSessionLock(sid, async () => {
        try {
          const session = await gameService.findSessionByGameId(sid);
          if (!session) {
            if (typeof ack === "function") ack({ ok: false, code: "NOT_FOUND", message: "Game session not found" });
            return;
          }

          joinUsersToSession(session.players.map((p) => p.user?._id || p.user), session);

          const actionId = data?.actionId || null;
          const { message, data: rollData } = await gameService.rollDice(socket.user._id, session._id, { actionId });
          const updatedSession = await GameSession.findById(session._id);
          const st = formatSessionState(updatedSession);
          const rooms = gameRooms(session, data?.gameId);

          const payload = {
            roomId: session.roomCode,
            roomCode: session.roomCode,
            gameId: String(session._id),
            sessionId: String(session._id),
            matchId: String(session._id),
            currentTurnPlayer: String(updatedSession.currentTurnPlayer),
            currentPlayerId: String(updatedSession.currentTurnPlayer),
            currentTurnSeat: updatedSession.currentTurnSeat !== undefined ? updatedSession.currentTurnSeat : 0,
            currentSeat: updatedSession.currentTurnSeat !== undefined ? updatedSession.currentTurnSeat : 0,
            playerId: String(socket.user._id),
            actionId,
            turnNumber: updatedSession.turnNumber || 1,
            stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
            actionSequence: updatedSession.actionSequence || updatedSession.__v || 0,
            diceValue: rollData.diceValue,
            diceResult: rollData.diceValue,
            turnId: String(updatedSession.__v || 0),
            legalMoves: rollData.legalMoves || rollData.movableTokenIds || [],
            movableTokenIds: rollData.movableTokenIds || [],
            turnPassed: Boolean(rollData.turnPassed),
            threeSixes: Boolean(rollData.threeSixes),
            gamePhase: updatedSession.gamePhase,
            phase: updatedSession.gamePhase,
            turn: st.turn,
            state: st,
            gameState: st,
          };

          // Broadcast to BOTH players in real time
          io.to(rooms).emit("dice_roll_result", payload);
          io.to(rooms).emit("dice_rolled", payload);

          // If turn was passed (no movable tokens or three 6s), emit turn_changed
          if (rollData.turnPassed) {
            const turnPayload = {
              roomId: session.roomCode,
              roomCode: session.roomCode,
              gameId: String(session._id),
              sessionId: String(session._id),
              matchId: String(session._id),
              currentTurnPlayer: String(updatedSession.currentTurnPlayer),
              currentPlayerId: String(updatedSession.currentTurnPlayer),
              currentTurnSeat: updatedSession.currentTurnSeat,
              currentSeat: updatedSession.currentTurnSeat,
              turnNumber: updatedSession.turnNumber || 1,
              stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
              actionSequence: updatedSession.actionSequence || updatedSession.__v || 0,
              actionId,
              getsExtraTurn: false,
              gamePhase: updatedSession.gamePhase,
              phase: updatedSession.gamePhase,
              turn: st.turn,
              state: st,
              gameState: st,
            };
            io.to(rooms).emit("turn_changed", turnPayload);
          }

          // Also emit updated game_state to all room channels
          io.to(rooms).emit("game_state", {
            roomId: session.roomCode,
            roomCode: session.roomCode,
            gameId: String(session._id),
            sessionId: String(session._id),
            matchId: String(session._id),
            stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
            actionSequence: updatedSession.actionSequence || updatedSession.__v || 0,
            currentTurnPlayer: String(updatedSession.currentTurnPlayer),
            currentPlayerId: String(updatedSession.currentTurnPlayer),
            currentTurnSeat: updatedSession.currentTurnSeat,
            turnNumber: updatedSession.turnNumber || 1,
            state: st,
            gameState: st,
          });

          if (typeof ack === "function") ack({ ok: true, data: { ...rollData, state: st, gameState: st } });
        } catch (err) {
          logger.warn("socket_roll_dice_error", { err: err.message, userId });
          const code = err.code || (err.statusCode === 403 ? "OUT_OF_TURN" : "DICE_ROLL_FAILED");
          socket.emit("invalid_move", {
            sessionId: String(sid),
            playerId: userId,
            actionId: data?.actionId || null,
            code,
            message: err.message,
          });
          socket.emit("game_error", {
            code,
            message: err.message,
          });
          if (typeof ack === "function") {
            ack({
              ok: false,
              code: err.code || (err.statusCode === 403 ? "FORBIDDEN" : (err.statusCode === 404 ? "NOT_FOUND" : "BAD_REQUEST")),
              message: err.message,
            });
          }
        }
      });
    };

    socket.on("dice_roll_requested", handleRollDice);
    socket.on("roll_dice", handleRollDice);

    // 6. Real-Time Token Movement
    const handleMoveToken = async (data, ack) => {
      const sid = data?.sessionId || data?.gameId || data?.matchId || data?.roomId || data?.roomCode;
      const tokenId = data?.tokenId !== undefined ? data?.tokenId : (data?.tokenIndex !== undefined ? data?.tokenIndex : data?.token);
      if (!sid || tokenId === undefined) {
        if (typeof ack === "function") {
          ack({ ok: false, code: "BAD_REQUEST", message: "sessionId/gameId and tokenId are required" });
        }
        return;
      }

      await withSessionLock(sid, async () => {
        try {
          const session = await gameService.findSessionByGameId(sid);
          if (!session) {
            if (typeof ack === "function") ack({ ok: false, code: "NOT_FOUND", message: "Game session not found" });
            return;
          }

          joinUsersToSession(session.players.map((p) => p.user?._id || p.user), session);

          const actionId = data?.actionId || null;
          const { message, data: moveData } = await gameService.moveToken(socket.user._id, session._id, tokenId, { actionId });
          const updatedSession = await GameSession.findById(session._id);
          const st = formatSessionState(updatedSession);
          const rooms = gameRooms(session, data?.gameId);

          const payload = {
            roomId: session.roomCode,
            roomCode: session.roomCode,
            gameId: String(session._id),
            sessionId: String(session._id),
            matchId: String(session._id),
            currentTurnPlayer: String(updatedSession.currentTurnPlayer),
            currentPlayerId: String(updatedSession.currentTurnPlayer),
            currentTurnSeat: updatedSession.currentTurnSeat !== undefined ? updatedSession.currentTurnSeat : 0,
            currentSeat: updatedSession.currentTurnSeat !== undefined ? updatedSession.currentTurnSeat : 0,
            playerId: String(socket.user._id),
            actionId,
            turnNumber: updatedSession.turnNumber || 1,
            stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
            actionSequence: updatedSession.actionSequence || updatedSession.__v || 0,
            tokenId: Number(tokenId),
            move: moveData.move || { tokenId: Number(tokenId) },
            gamePhase: updatedSession.gamePhase,
            phase: updatedSession.gamePhase,
            turn: st.turn,
            state: st,
            gameState: st,
          };

          // Broadcast token move to BOTH devices
          io.to(rooms).emit("token_moved", payload);

          // Broadcast turn changed (unless game completed)
          if (!moveData.gameCompleted) {
            const turnPayload = {
              roomId: session.roomCode,
              roomCode: session.roomCode,
              gameId: String(session._id),
              sessionId: String(session._id),
              matchId: String(session._id),
              currentTurnPlayer: String(updatedSession.currentTurnPlayer),
              currentPlayerId: String(updatedSession.currentTurnPlayer),
              currentTurnSeat: updatedSession.currentTurnSeat,
              currentSeat: updatedSession.currentTurnSeat,
              turnNumber: updatedSession.turnNumber || 1,
              stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
              actionSequence: updatedSession.actionSequence || updatedSession.__v || 0,
              actionId,
              getsExtraTurn: Boolean(moveData.move?.getsExtraTurn),
              gamePhase: updatedSession.gamePhase,
              phase: updatedSession.gamePhase,
              turn: st.turn,
              state: st,
              gameState: st,
            };
            io.to(rooms).emit("turn_changed", turnPayload);
          }

          // Also emit updated game_state to all room channels
          io.to(rooms).emit("game_state", {
            roomId: session.roomCode,
            roomCode: session.roomCode,
            gameId: String(session._id),
            sessionId: String(session._id),
            matchId: String(session._id),
            stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
            actionSequence: updatedSession.actionSequence || updatedSession.__v || 0,
            currentTurnPlayer: String(updatedSession.currentTurnPlayer),
            currentPlayerId: String(updatedSession.currentTurnPlayer),
            currentTurnSeat: updatedSession.currentTurnSeat,
            turnNumber: updatedSession.turnNumber || 1,
            state: st,
            gameState: st,
          });

          if (moveData.gameCompleted) {
            const finishedPayload = {
              roomId: session.roomCode,
              roomCode: session.roomCode,
              gameId: String(session._id),
              sessionId: String(session._id),
              matchId: String(session._id),
              winnerId: moveData.winner ? String(moveData.winner) : (updatedSession.winner ? String(updatedSession.winner) : null),
              ranking: updatedSession.players.map((p) => ({ userId: String(p.user), rank: p.rank })),
              gamePhase: "game_over",
              phase: "game_over",
              turnNumber: updatedSession.turnNumber || 1,
              stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
              state: st,
              gameState: st,
            };
            io.to(rooms).emit("game_over", finishedPayload);
            io.to(rooms).emit("match_finished", finishedPayload);
          }

          if (typeof ack === "function") ack({ ok: true, data: { ...moveData, state: st, gameState: st } });
        } catch (err) {
          logger.warn("socket_move_token_error", { err: err.message, userId });
          const code = err.code || "INVALID_MOVE";
          socket.emit("invalid_move", {
            sessionId: String(sid),
            playerId: userId,
            actionId: data?.actionId || null,
            code,
            message: err.message,
          });
          socket.emit("game_error", {
            code,
            message: err.message,
          });
          if (typeof ack === "function") {
            ack({
              ok: false,
              code: err.code || (err.statusCode === 403 ? "FORBIDDEN" : (err.statusCode === 404 ? "NOT_FOUND" : "BAD_REQUEST")),
              message: err.message,
            });
          }
        }
      });
    };

    socket.on("token_move_requested", handleMoveToken);
    socket.on("move_token", handleMoveToken);

    // 6b. Request Game State
    socket.on("request_game_state", async (data, ack) => {
      try {
        const sid = data?.sessionId || data?.gameId || data?.matchId || data?.roomId || data?.roomCode;
        const session = await gameService.findSessionByGameId(sid);
        if (!session) {
          if (typeof ack === "function") ack({ ok: false, code: "NOT_FOUND", message: "Game session not found" });
          return;
        }
        const st = formatSessionState(session);
        const mine = viewerView(st, userId);
        socket.emit("game_state", { state: mine, gameState: mine });
        if (typeof ack === "function") ack({ ok: true, data: { state: mine, gameState: mine } });
      } catch (err) {
        if (typeof ack === "function") ack({ ok: false, message: err.message });
      }
    });

    // 6c. Player Reconnected
    socket.on("player_reconnected", async (data, ack) => {
      try {
        const sid = data?.sessionId || data?.gameId || data?.matchId || data?.roomId || data?.roomCode;
        const session = await gameService.findSessionByGameId(sid);
        if (session) {
          joinSocketToSession(socket, session);
          const st = formatSessionState(session);
          const rooms = gameRooms(session);
          io.to(rooms).emit("player_reconnected", {
            roomId: session.roomCode,
            roomCode: session.roomCode,
            gameId: String(session._id),
            sessionId: String(session._id),
            matchId: String(session._id),
            userId,
            playerId: userId,
            turnNumber: session.turnNumber || 1,
            stateVersion: session.actionSequence || session.__v || 0,
            state: st,
            gameState: st,
          });
          socket.emit("game_state", { state: st, gameState: st });
        }
        if (typeof ack === "function") ack({ ok: true });
      } catch (err) {
        if (typeof ack === "function") ack({ ok: false, message: err.message });
      }
    });

    // 7. Turn Timeout Handling
    socket.on("turn_timeout", async (data, ack) => {
      try {
        const sessionId = data?.sessionId;
        if (!sessionId) {
          if (typeof ack === "function") ack({ ok: false, message: "sessionId is required" });
          return;
        }
        const { gameCompleted, session } = await gameService.handleTurnTimeout(socket.user._id, sessionId);
        broadcastTimeoutResult(session, gameCompleted);
        const st = formatSessionState(session);
        if (typeof ack === "function") ack({ ok: true, data: { session: st } });
      } catch (err) {
        if (typeof ack === "function") ack({ ok: false, message: err.message });
      }
    });

    // 8. Surrender Match
    socket.on("surrender_match", async (data, ack) => {
      try {
        const sessionId = data?.sessionId;
        if (!sessionId) {
          if (typeof ack === "function") ack({ ok: false, message: "sessionId is required" });
          return;
        }
        const { gameCompleted, session } = await gameService.surrenderMatch(socket.user._id, sessionId);
        const st = formatSessionState(session);
        io.to(`session:${sessionId}`).emit("player_surrendered", {
          sessionId: String(sessionId),
          userId,
          state: st,
        });
        if (gameCompleted) {
          io.to(`session:${sessionId}`).emit("match_finished", {
            sessionId: String(sessionId),
            winnerId: session.winner ? String(session.winner) : null,
            ranking: session.players.map((p) => ({ userId: String(p.user), rank: p.rank })),
            state: st,
          });
        }
        if (typeof ack === "function") ack({ ok: true, data: { session: st } });
      } catch (err) {
        if (typeof ack === "function") ack({ ok: false, message: err.message });
      }
    });

    // 9. Nearby Location-Based Matchmaking Sockets
    socket.on("nearby_matchmaking_join", async (data, ack) => {
      try {
        const matchmakingService = require("../modules/matchmaking/services/matchmaking.service");
        const result = await matchmakingService.joinNearbyQueue(socket.user, data);
        if (typeof ack === "function") ack({ ok: true, data: result });
      } catch (err) {
        logger.warn("nearby_matchmaking_join_error", { err: err.message, userId });
        const code = err.code || (err.statusCode === 400 ? "BAD_REQUEST" : "MATCHMAKING_ERROR");
        socket.emit("matchmaking_error", { code, message: err.message });
        if (typeof ack === "function") ack({ ok: false, code, message: err.message });
      }
    });

    socket.on("nearby_matchmaking_cancel", async (_data, ack) => {
      try {
        const matchmakingService = require("../modules/matchmaking/services/matchmaking.service");
        const result = await matchmakingService.cancelNearbyQueue(userId);
        if (typeof ack === "function") ack({ ok: true, data: result });
      } catch (err) {
        logger.warn("nearby_matchmaking_cancel_error", { err: err.message, userId });
        if (typeof ack === "function") ack({ ok: false, message: err.message });
      }
    });

    socket.on("nearby_location_update", async (data, ack) => {
      try {
        const matchmakingService = require("../modules/matchmaking/services/matchmaking.service");
        const result = await matchmakingService.updateNearbyLocation(userId, data);
        if (typeof ack === "function") ack({ ok: true, data: result });
      } catch (err) {
        logger.warn("nearby_location_update_error", { err: err.message, userId });
        if (typeof ack === "function") ack({ ok: false, message: err.message });
      }
    });

    // Handle disconnecting to broadcast to all session rooms before leaving
    socket.on("disconnecting", () => {
      // Another live socket of the same user (reconnect overlap) => they are still online.
      if (!removePresence(userId, socket.id)) return;

      // Automatically clean up active searching nearby queue on full disconnect
      try {
        const matchmakingService = require("../modules/matchmaking/services/matchmaking.service");
        matchmakingService.cancelNearbyQueue(userId).catch(() => {});
      } catch (_) {}

      for (const room of socket.rooms) {
        if (room.startsWith("session:")) {
          const sid = room.replace("session:", "");
          socket.to(room).emit("player_disconnected", {
            channel: "session",
            id: sid,
            sessionId: sid,
            gameId: sid,
            userId,
            playerId: userId,
          });
        } else if (room.startsWith("room:")) {
          const code = room.replace("room:", "");
          socket.to(room).emit("player_disconnected", {
            channel: "room",
            id: code,
            roomId: code,
            roomCode: code,
            userId,
            playerId: userId,
          });
        }
      }
    });

    socket.on("disconnect", (reason) => {
      logger.info("socket_disconnected", {
        socketId: socket.id,
        userId,
        reason,
      });
    });
  });

  return io;
};

const getIO = () => io;

/**
 * Emit an event to a specific user's private room across all their active socket connections.
 */
const emitToUser = (userId, event, payload) => {
  if (!io || !userId) return false;
  const userRoom = `user:${String(userId)}`;
  io.to(userRoom).emit(event, payload);
  return true;
};

/**
 * Emit an event to all participants in a game session room.
 */
const emitToSession = (sessionId, event, payload) => {
  if (!io || !sessionId) return false;
  const sid = String(sessionId);
  const rooms = new Set([`session:${sid}`, `game:${sid}`]);
  if (payload?.roomCode) {
    rooms.add(`room:${String(payload.roomCode).toUpperCase()}`);
    rooms.add(`room:${String(payload.roomCode)}`);
  }
  if (payload?.roomId) {
    rooms.add(`room:${String(payload.roomId).toUpperCase()}`);
    rooms.add(`game:${String(payload.roomId)}`);
  }
  io.to([...rooms]).emit(event, payload);
  return true;
};

/**
 * Emit an event to all participants in a game room lobby.
 */
const emitToRoom = (roomCode, event, payload) => {
  if (!io || !roomCode) return false;
  const code = String(roomCode).toUpperCase();
  const rooms = new Set([`room:${code}`, `room:${String(roomCode)}`]);
  if (payload?.sessionId) {
    rooms.add(`session:${String(payload.sessionId)}`);
    rooms.add(`game:${String(payload.sessionId)}`);
  }
  if (payload?.gameId) {
    rooms.add(`game:${String(payload.gameId)}`);
  }
  io.to([...rooms]).emit(event, payload);
  return true;
};

/**
 * Emit an event across session, game and room channels.
 */
const emitToGame = (sessionOrId, event, payload) => {
  if (!io || !sessionOrId) return false;
  if (typeof sessionOrId === "object") {
    const rooms = gameRooms(sessionOrId);
    io.to(rooms).emit(event, payload);
  } else {
    const sid = String(sessionOrId);
    const rooms = new Set([`session:${sid}`, `game:${sid}`]);
    if (payload?.roomCode) {
      rooms.add(`room:${String(payload.roomCode).toUpperCase()}`);
      rooms.add(`room:${String(payload.roomCode)}`);
    }
    if (payload?.roomId) {
      rooms.add(`room:${String(payload.roomId).toUpperCase()}`);
      rooms.add(`game:${String(payload.roomId)}`);
    }
    io.to([...rooms]).emit(event, payload);
  }
  return true;
};

const close = async () => {
  if (io) {
    await new Promise((resolve) => io.close(resolve));
    io = null;
  }
};

module.exports = {
  init,
  getIO,
  emitToUser,
  emitToSession,
  emitToRoom,
  emitToGame,
  formatSessionState,
  viewerView,
  isUserOnline,
  gameRooms,
  joinSocketToSession,
  joinUsersToSession,
  broadcastTurnChanged,
  broadcastGameState,
  broadcastMatchFinished,
  broadcastTimeoutResult,
  broadcastGameStartedToPlayers,
  close,
};
