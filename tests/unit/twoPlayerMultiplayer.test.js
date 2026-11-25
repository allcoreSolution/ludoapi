"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");

const GameSession = require("../../src/modules/games/models/GameSession");
const GameRoom = require("../../src/modules/rooms/models/GameRoom");
const roomService = require("../../src/modules/rooms/services/room.service");
const gameService = require("../../src/modules/games/services/game.service");
const socketManager = require("../../src/sockets/socketManager");
const secureRandom = require("../../utils/secureRandom");

// Helper to create an in-memory two-client Socket.IO test harness
const createTwoClientHarness = () => {
  const roomsMap = new Map(); // roomName -> Set(socket)
  const sockets = [];

  class MockSocket {
    constructor(userId, name) {
      this.id = `sock_${userId}_${Math.random().toString(36).substring(2, 7)}`;
      this.user = { _id: userId, name, username: name, avatar: "" };
      this.rooms = new Set([`user:${userId}`]);
      this.events = [];
      this.handlers = new Map();

      // Join personal user room initially
      if (!roomsMap.has(`user:${userId}`)) {
        roomsMap.set(`user:${userId}`, new Set());
      }
      roomsMap.get(`user:${userId}`).add(this);
    }

    join(roomOrRooms) {
      const list = Array.isArray(roomOrRooms) ? roomOrRooms : [roomOrRooms];
      for (const r of list) {
        if (!r) continue;
        const key = String(r);
        this.rooms.add(key);
        if (!roomsMap.has(key)) {
          roomsMap.set(key, new Set());
        }
        roomsMap.get(key).add(this);
      }
    }

    leave(room) {
      const key = String(room);
      this.rooms.delete(key);
      if (roomsMap.has(key)) {
        roomsMap.get(key).delete(this);
      }
    }

    emit(event, payload) {
      this.events.push({ event, payload, timestamp: Date.now() });
    }

    on(event, handler) {
      this.handlers.set(event, handler);
    }

    async trigger(event, data) {
      const handler = this.handlers.get(event);
      if (!handler) return;
      return new Promise((resolve) => {
        let ackCalled = false;
        const ack = (res) => {
          ackCalled = true;
          resolve(res);
        };
        const maybePromise = handler(data, ack);
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.then(() => {
            if (!ackCalled) resolve();
          });
        } else if (!ackCalled) {
          resolve();
        }
      });
    }

    getEvents(eventName) {
      return this.events.filter((e) => e.event === eventName);
    }

    getLastEvent(eventName) {
      const matched = this.getEvents(eventName);
      return matched.length > 0 ? matched[matched.length - 1] : null;
    }

    clearEvents() {
      this.events = [];
    }
  }

  const mockIo = {
    to(roomOrRooms) {
      const targets = Array.isArray(roomOrRooms) ? roomOrRooms : [roomOrRooms];
      const targetSockets = new Set();
      for (const r of targets) {
        const set = roomsMap.get(String(r));
        if (set) {
          for (const s of set) targetSockets.add(s);
        }
      }
      return {
        emit(event, payload) {
          for (const s of targetSockets) {
            s.emit(event, payload);
          }
        },
      };
    },
    in(userRoom) {
      const set = roomsMap.get(String(userRoom)) || new Set();
      return {
        socketsJoin(targetRooms) {
          const list = Array.isArray(targetRooms) ? targetRooms : [targetRooms];
          for (const s of set) {
            s.join(list);
          }
        },
      };
    },
  };

  // Wire up socketManager with mockIo
  const server = require("node:http").createServer();
  socketManager.init(server);
  const realIo = socketManager.getIO();
  realIo.to = mockIo.to.bind(mockIo);
  realIo.in = mockIo.in.bind(mockIo);

  const clientA = new MockSocket("6742d80b9a4f21001e3a9851", "Player A");
  const clientB = new MockSocket("6742d80b9a4f21001e3a9852", "Player B");
  sockets.push(clientA, clientB);

  // Register all listeners on each mock socket
  const setupSocket = (sock) => {
    // 1. Join room
    sock.on("join_room", async (data, ack) => {
      const roomCode = (data?.roomCode || data?.roomId || "").trim().toUpperCase();
      if (!roomCode) {
        if (typeof ack === "function") ack({ ok: false, code: "BAD_REQUEST" });
        return;
      }
      sock.join(`room:${roomCode}`);
      realIo.to(`room:${roomCode}`).emit("player_joined", {
        roomCode,
        roomId: roomCode,
        userId: String(sock.user._id),
        playerId: String(sock.user._id),
        name: sock.user.name,
      });
      if (typeof ack === "function") ack({ ok: true, roomCode });
    });

    // 2. Start match
    sock.on("start_match", async (data, ack) => {
      const roomCode = (data?.roomCode || data?.roomId || "").trim().toUpperCase();
      const { session } = await gameService.startGame(sock.user._id, roomCode);
      socketManager.joinUsersToSession(session.players.map((p) => p.user?._id || p.user), session);
      socketManager.joinSocketToSession(sock, session);

      const st = socketManager.formatSessionState(session);
      const rooms = socketManager.gameRooms(session);
      const payload = {
        roomId: roomCode,
        roomCode,
        gameId: String(session._id),
        sessionId: String(session._id),
        matchId: String(session._id),
        turnNumber: session.turnNumber || 1,
        stateVersion: session.actionSequence || session.__v || 0,
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

      realIo.to(rooms).emit("match_started", payload);
      realIo.to(rooms).emit("game_started", payload);
      realIo.to(rooms).emit("game_state", { state: st, gameState: st });
      if (typeof ack === "function") ack({ ok: true, data: payload });
    });

    // 3. Roll dice
    sock.on("dice_roll_requested", async (data, ack) => {
      const sid = data?.sessionId || data?.gameId || data?.matchId || data?.roomId || data?.roomCode;
      const session = await gameService.findSessionByGameId(sid);
      if (!session) {
        if (typeof ack === "function") ack({ ok: false, code: "NOT_FOUND" });
        return;
      }

      socketManager.joinUsersToSession(session.players.map((p) => p.user?._id || p.user), session);

      try {
        const actionId = data?.actionId || null;
        const { data: rollData } = await gameService.rollDice(sock.user._id, session._id, { actionId });
        const updatedSession = await GameSession.findById(session._id);
        const st = socketManager.formatSessionState(updatedSession);
        const rooms = socketManager.gameRooms(session, data?.gameId);

        const payload = {
          roomId: session.roomCode,
          roomCode: session.roomCode,
          gameId: String(session._id),
          sessionId: String(session._id),
          matchId: String(session._id),
          playerId: String(sock.user._id),
          actionId,
          turnNumber: updatedSession.turnNumber || 1,
          stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
          diceValue: rollData.diceValue,
          diceResult: rollData.diceValue,
          legalMoves: rollData.legalMoves || rollData.movableTokenIds || [],
          movableTokenIds: rollData.movableTokenIds || [],
          turnPassed: Boolean(rollData.turnPassed),
          gamePhase: updatedSession.gamePhase,
          phase: updatedSession.gamePhase,
          turn: st.turn,
          state: st,
          gameState: st,
        };

        realIo.to(rooms).emit("dice_roll_result", payload);
        realIo.to(rooms).emit("dice_rolled", payload);

        if (rollData.turnPassed) {
          const turnPayload = {
            roomId: session.roomCode,
            roomCode: session.roomCode,
            gameId: String(session._id),
            sessionId: String(session._id),
            matchId: String(session._id),
            currentPlayerId: String(updatedSession.currentTurnPlayer),
            currentTurnSeat: updatedSession.currentTurnSeat,
            currentSeat: updatedSession.currentTurnSeat,
            turnNumber: updatedSession.turnNumber || 1,
            stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
            getsExtraTurn: false,
            gamePhase: updatedSession.gamePhase,
            phase: updatedSession.gamePhase,
            turn: st.turn,
            state: st,
            gameState: st,
          };
          realIo.to(rooms).emit("turn_changed", turnPayload);
        }

        realIo.to(rooms).emit("game_state", { state: st, gameState: st });
        if (typeof ack === "function") ack({ ok: true, data: { ...rollData, state: st, gameState: st } });
      } catch (err) {
        const code = err.code || (err.statusCode === 403 ? "OUT_OF_TURN" : "DICE_ROLL_FAILED");
        sock.emit("invalid_move", {
          sessionId: String(sid),
          playerId: String(sock.user._id),
          actionId: data?.actionId || null,
          code,
          message: err.message,
        });
        if (typeof ack === "function") ack({ ok: false, code, message: err.message });
      }
    });

    // 4. Move token
    sock.on("token_move_requested", async (data, ack) => {
      const sid = data?.sessionId || data?.gameId || data?.matchId || data?.roomId || data?.roomCode;
      const tokenId = data?.tokenId !== undefined ? data?.tokenId : (data?.tokenIndex !== undefined ? data?.tokenIndex : data?.token);
      const session = await gameService.findSessionByGameId(sid);
      if (!session) {
        if (typeof ack === "function") ack({ ok: false, code: "NOT_FOUND" });
        return;
      }

      socketManager.joinUsersToSession(session.players.map((p) => p.user?._id || p.user), session);

      try {
        const actionId = data?.actionId || null;
        const { data: moveData } = await gameService.moveToken(sock.user._id, session._id, tokenId, { actionId });
        const updatedSession = await GameSession.findById(session._id);
        const st = socketManager.formatSessionState(updatedSession);
        const rooms = socketManager.gameRooms(session, data?.gameId);

        const payload = {
          roomId: session.roomCode,
          roomCode: session.roomCode,
          gameId: String(session._id),
          sessionId: String(session._id),
          matchId: String(session._id),
          playerId: String(sock.user._id),
          actionId,
          turnNumber: updatedSession.turnNumber || 1,
          stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
          tokenId: Number(tokenId),
          move: moveData.move || { tokenId: Number(tokenId) },
          gamePhase: updatedSession.gamePhase,
          phase: updatedSession.gamePhase,
          turn: st.turn,
          state: st,
          gameState: st,
        };

        realIo.to(rooms).emit("token_moved", payload);

        if (!moveData.gameCompleted) {
          const turnPayload = {
            roomId: session.roomCode,
            roomCode: session.roomCode,
            gameId: String(session._id),
            sessionId: String(session._id),
            matchId: String(session._id),
            currentPlayerId: String(updatedSession.currentTurnPlayer),
            currentTurnSeat: updatedSession.currentTurnSeat,
            currentSeat: updatedSession.currentTurnSeat,
            turnNumber: updatedSession.turnNumber || 1,
            stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
            actionId,
            getsExtraTurn: Boolean(moveData.move?.getsExtraTurn),
            gamePhase: updatedSession.gamePhase,
            phase: updatedSession.gamePhase,
            turn: st.turn,
            state: st,
            gameState: st,
          };
          realIo.to(rooms).emit("turn_changed", turnPayload);
        }

        realIo.to(rooms).emit("game_state", { state: st, gameState: st });

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
            turnNumber: updatedSession.turnNumber || 1,
            stateVersion: updatedSession.actionSequence || updatedSession.__v || 0,
            state: st,
            gameState: st,
          };
          realIo.to(rooms).emit("game_over", finishedPayload);
          realIo.to(rooms).emit("match_finished", finishedPayload);
        }

        if (typeof ack === "function") ack({ ok: true, data: { ...moveData, state: st, gameState: st } });
      } catch (err) {
        const code = err.code || "INVALID_MOVE";
        sock.emit("invalid_move", {
          sessionId: String(sid),
          playerId: String(sock.user._id),
          actionId: data?.actionId || null,
          code,
          message: err.message,
        });
        if (typeof ack === "function") ack({ ok: false, code, message: err.message });
      }
    });

    // 5. Join session (reconnect)
    sock.on("join_session", async (data, ack) => {
      const sid = data?.sessionId || data?.gameId || data?.matchId || data?.roomId || data?.roomCode;
      const session = await gameService.findSessionByGameId(sid);
      if (session) {
        socketManager.joinSocketToSession(sock, session);
        socketManager.joinUsersToSession(session.players.map((p) => p.user?._id || p.user), session);
        const st = socketManager.formatSessionState(session);
        const rooms = socketManager.gameRooms(session);
        realIo.to(rooms).emit("player_reconnected", {
          roomId: session.roomCode,
          roomCode: session.roomCode,
          gameId: String(session._id),
          sessionId: String(session._id),
          userId: String(sock.user._id),
          playerId: String(sock.user._id),
          state: st,
          gameState: st,
        });
        sock.emit("game_state", { state: st, gameState: st });
        if (typeof ack === "function") ack({ ok: true, data: { state: st, gameState: st } });
      }
    });
  };

  setupSocket(clientA);
  setupSocket(clientB);

  return { clientA, clientB, roomsMap };
};

// Fixture builder for 2-player session
const mkFixtureSession = (overrides = {}) => {
  const session = {
    _id: "6742db5e9a4f21001e3a9899",
    room: "6742db5e9a4f21001e3a9898",
    roomCode: "SYNC77",
    gameMode: "twoPlayer",
    status: "in_progress",
    __v: 1,
    actionSequence: 1,
    turnNumber: 1,
    currentTurnPlayer: "6742d80b9a4f21001e3a9851", // Player A
    currentTurnSeat: 0,
    turnStatus: "WAITING_FOR_ROLL",
    gamePhase: "waiting_for_roll",
    lastDiceValue: null,
    consecutiveSixes: 0,
    turnDeadline: new Date(Date.now() + 15000),
    history: [],
    players: [
      {
        user: "6742d80b9a4f21001e3a9851",
        name: "Player A",
        avatar: "",
        seatIndex: 0,
        color: "Red",
        score: 0,
        missedTurns: 0,
        hasSurrendered: false,
        tokens: [
          { tokenId: 0, step: 0, isHome: false },
          { tokenId: 1, step: 0, isHome: false },
          { tokenId: 2, step: 0, isHome: false },
          { tokenId: 3, step: 0, isHome: false },
        ],
      },
      {
        user: "6742d80b9a4f21001e3a9852",
        name: "Player B",
        avatar: "",
        seatIndex: 1,
        color: "Green",
        score: 0,
        missedTurns: 0,
        hasSurrendered: false,
        tokens: [
          { tokenId: 0, step: 0, isHome: false },
          { tokenId: 1, step: 0, isHome: false },
          { tokenId: 2, step: 0, isHome: false },
          { tokenId: 3, step: 0, isHome: false },
        ],
      },
    ],
    async save() {
      return this;
    },
    ...overrides,
  };
  return session;
};

// -----------------------------------------------------------------------------
// 22 PARITY INTEGRATION TESTS
// -----------------------------------------------------------------------------

test("1 & 2. Player A creates room, Player B joins room lobby", async () => {
  const { clientA, clientB, roomsMap } = createTwoClientHarness();
  const roomCode = "SYNC77";

  await clientA.trigger("join_room", { roomCode });
  assert.equal(roomsMap.get(`room:${roomCode}`).has(clientA), true);

  await clientB.trigger("join_room", { roomCode });
  assert.equal(roomsMap.get(`room:${roomCode}`).has(clientB), true);

  const joinEvent = clientA.getLastEvent("player_joined");
  assert.ok(joinEvent);
  assert.equal(joinEvent.payload.playerId, "6742d80b9a4f21001e3a9852");
});

test("3 & 4. Both Player A and Player B receive game_started and identical authoritative game_state", async () => {
  const { clientA, clientB } = createTwoClientHarness();
  const session = mkFixtureSession();

  GameRoom.findOne = async () => ({
    _id: session.room,
    roomCode: session.roomCode,
    host: clientA.user._id,
    maxPlayers: 2,
    players: [
      { user: clientA.user._id, name: clientA.user.name, seatIndex: 0, color: "Red" },
      { user: clientB.user._id, name: clientB.user.name, seatIndex: 1, color: "Green" },
    ],
  });
  GameSession.findOne = async () => null;
  GameRoom.findOneAndUpdate = async () => ({
    _id: session.room,
    roomCode: session.roomCode,
    maxPlayers: 2,
    players: [
      { user: clientA.user._id, name: clientA.user.name, seatIndex: 0, color: "Red" },
      { user: clientB.user._id, name: clientB.user.name, seatIndex: 1, color: "Green" },
    ],
  });
  GameSession.create = async () => session;

  clientA.clearEvents();
  clientB.clearEvents();

  await clientA.trigger("start_match", { roomCode: session.roomCode });

  const startA = clientA.getLastEvent("game_started");
  const startB = clientB.getLastEvent("game_started");
  assert.ok(startA, "Player A received game_started");
  assert.ok(startB, "Player B received game_started");
  assert.equal(startA.payload.sessionId, String(session._id));
  assert.equal(startB.payload.sessionId, String(session._id));

  const stateA = clientA.getLastEvent("game_state");
  const stateB = clientB.getLastEvent("game_state");
  assert.ok(stateA, "Player A received game_state");
  assert.ok(stateB, "Player B received game_state");
  assert.deepEqual(stateA.payload.state, stateB.payload.state, "Authoritative state is identical for both clients");
});

test("5 & 6. Player A maps to seat 0 / Red and Player B maps to seat 1 / Green", () => {
  const session = mkFixtureSession();
  const state = socketManager.formatSessionState(session);

  const playerA = state.players.find((p) => p.playerId === "6742d80b9a4f21001e3a9851");
  const playerB = state.players.find((p) => p.playerId === "6742d80b9a4f21001e3a9852");

  assert.ok(playerA);
  assert.equal(playerA.seatIndex, 0);
  assert.equal(playerA.color, "Red");

  assert.ok(playerB);
  assert.equal(playerB.seatIndex, 1);
  assert.equal(playerB.color, "Green");

  assert.equal(state.currentPlayerId, "6742d80b9a4f21001e3a9851");
  assert.equal(state.currentSeat, 0);
});

test("7 & 8. Player A rolls dice and Player B receives the exact same dice_roll_result in real time", async () => {
  const { clientA, clientB } = createTwoClientHarness();
  const session = mkFixtureSession();

  GameSession.findById = async () => session;
  secureRandom.rollDie = () => 4;

  clientA.clearEvents();
  clientB.clearEvents();

  await clientA.trigger("dice_roll_requested", { sessionId: String(session._id) });

  const rollA = clientA.getLastEvent("dice_roll_result");
  const rollB = clientB.getLastEvent("dice_roll_result");

  assert.ok(rollA, "Player A received dice_roll_result");
  assert.ok(rollB, "Player B received dice_roll_result");
  assert.equal(rollA.payload.diceValue, 4);
  assert.equal(rollB.payload.diceValue, 4);
  assert.equal(rollB.payload.playerId, "6742d80b9a4f21001e3a9851");
  assert.equal(rollB.payload.gamePhase, "waiting_for_move");
});

test("9 & 10. Player A performs valid move and Player B receives token_moved with updated token positions", async () => {
  const { clientA, clientB } = createTwoClientHarness();
  const session = mkFixtureSession({
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 4,
  });

  GameSession.findById = async () => session;

  clientA.clearEvents();
  clientB.clearEvents();

  await clientA.trigger("token_move_requested", { sessionId: String(session._id), tokenId: 0 });

  const moveA = clientA.getLastEvent("token_moved");
  const moveB = clientB.getLastEvent("token_moved");

  assert.ok(moveA, "Player A received token_moved");
  assert.ok(moveB, "Player B received token_moved");
  assert.equal(moveB.payload.tokenId, 0);
  assert.equal(moveB.payload.move.newStep, 4);
  assert.equal(moveB.payload.playerId, "6742d80b9a4f21001e3a9851");
});

test("11. Player B gets turn via turn_changed with currentPlayerId == Player B and currentSeat == 1", async () => {
  const { clientA, clientB } = createTwoClientHarness();
  const session = mkFixtureSession({
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 4,
  });

  GameSession.findById = async () => session;

  clientA.clearEvents();
  clientB.clearEvents();

  await clientA.trigger("token_move_requested", { sessionId: String(session._id), tokenId: 0 });

  const turnEventB = clientB.getLastEvent("turn_changed");
  assert.ok(turnEventB, "Player B received turn_changed");
  assert.equal(turnEventB.payload.currentPlayerId, "6742d80b9a4f21001e3a9852");
  assert.equal(turnEventB.payload.currentSeat, 1);
  assert.equal(turnEventB.payload.turnNumber, 2);
  assert.equal(turnEventB.payload.gamePhase, "waiting_for_roll");
});

test("12. Player B can roll dice when it is Player B's turn", async () => {
  const { clientA, clientB } = createTwoClientHarness();
  const session = mkFixtureSession({
    currentTurnPlayer: "6742d80b9a4f21001e3a9852", // Player B
    currentTurnSeat: 1,
    turnNumber: 2,
    turnStatus: "WAITING_FOR_ROLL",
    gamePhase: "waiting_for_roll",
  });

  GameSession.findById = async () => session;
  secureRandom.rollDie = () => 3;

  clientA.clearEvents();
  clientB.clearEvents();

  await clientB.trigger("dice_roll_requested", { sessionId: String(session._id) });

  const rollB = clientB.getLastEvent("dice_roll_result");
  const rollA = clientA.getLastEvent("dice_roll_result");

  assert.ok(rollB, "Player B received dice roll result");
  assert.ok(rollA, "Player A received Player B's dice roll result");
  assert.equal(rollB.payload.diceValue, 3);
  assert.equal(rollB.payload.playerId, "6742d80b9a4f21001e3a9852");
  assert.equal(rollB.payload.gamePhase, "waiting_for_move");
});

test("13. Player A cannot roll during Player B's turn and receives OUT_OF_TURN rejection", async () => {
  const { clientA } = createTwoClientHarness();
  const session = mkFixtureSession({
    currentTurnPlayer: "6742d80b9a4f21001e3a9852", // Player B's turn
    currentTurnSeat: 1,
    turnStatus: "WAITING_FOR_ROLL",
    gamePhase: "waiting_for_roll",
  });

  GameSession.findById = async () => session;
  clientA.clearEvents();

  await clientA.trigger("dice_roll_requested", { sessionId: String(session._id) });

  const errEvent = clientA.getLastEvent("invalid_move");
  assert.ok(errEvent);
  assert.equal(errEvent.payload.code, "OUT_OF_TURN");
});

test("14 & 15. Player B moves their own token and Player A receives Player B's token_moved", async () => {
  const { clientA, clientB } = createTwoClientHarness();
  const session = mkFixtureSession({
    currentTurnPlayer: "6742d80b9a4f21001e3a9852", // Player B
    currentTurnSeat: 1,
    turnNumber: 2,
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 3,
  });

  GameSession.findById = async () => session;

  clientA.clearEvents();
  clientB.clearEvents();

  await clientB.trigger("token_move_requested", { sessionId: String(session._id), tokenId: 1 });

  const moveB = clientB.getLastEvent("token_moved");
  const moveA = clientA.getLastEvent("token_moved");

  assert.ok(moveB, "Player B received token_moved");
  assert.ok(moveA, "Player A received Player B's token_moved");
  assert.equal(moveA.payload.playerId, "6742d80b9a4f21001e3a9852");
  assert.equal(moveA.payload.tokenId, 1);
  assert.equal(moveA.payload.move.newStep, 3);
});

test("16. Both clients remain synchronized with identical stateVersion and tokens", async () => {
  const session = mkFixtureSession({
    actionSequence: 5,
    turnNumber: 3,
  });
  const st = socketManager.formatSessionState(session);

  assert.equal(st.stateVersion, 5);
  assert.equal(st.turnNumber, 3);
  assert.ok(st.tokens["6742d80b9a4f21001e3a9851"]);
  assert.ok(st.tokens["6742d80b9a4f21001e3a9852"]);

  const viewerA = socketManager.viewerView(st, "6742d80b9a4f21001e3a9851");
  const viewerB = socketManager.viewerView(st, "6742d80b9a4f21001e3a9852");

  assert.equal(viewerA.me.isMyTurn, true);
  assert.equal(viewerB.me.isMyTurn, false);
  assert.equal(viewerA.me.seatIndex, 0);
  assert.equal(viewerB.me.seatIndex, 1);
});

test("17. Reconnection restores authoritative state and emits player_reconnected to table", async () => {
  const { clientA, clientB } = createTwoClientHarness();
  const session = mkFixtureSession({
    currentTurnPlayer: "6742d80b9a4f21001e3a9852",
    currentTurnSeat: 1,
  });

  GameSession.findById = async () => session;
  clientA.clearEvents();
  clientB.clearEvents();

  await clientB.trigger("join_session", { sessionId: String(session._id) });

  const reconA = clientA.getLastEvent("player_reconnected");
  assert.ok(reconA, "Player A notified of Player B reconnection");
  assert.equal(reconA.payload.playerId, "6742d80b9a4f21001e3a9852");

  const stateB = clientB.getLastEvent("game_state");
  assert.ok(stateB, "Player B received restored authoritative game_state");
});

test("18. Invalid move (illegal token ID) is rejected with INVALID_MOVE", async () => {
  const { clientA } = createTwoClientHarness();
  const session = mkFixtureSession({
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 4,
  });

  GameSession.findById = async () => session;
  clientA.clearEvents();

  await clientA.trigger("token_move_requested", { sessionId: String(session._id), tokenId: 99 });

  const err = clientA.getLastEvent("invalid_move");
  assert.ok(err);
  assert.equal(err.payload.code, "INVALID_MOVE");
});

test("19. Duplicate roll request is rejected when not in waiting_for_roll phase", async () => {
  const { clientA } = createTwoClientHarness();
  const session = mkFixtureSession({
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 4,
  });

  GameSession.findById = async () => session;
  clientA.clearEvents();

  await clientA.trigger("dice_roll_requested", { sessionId: String(session._id) });

  const err = clientA.getLastEvent("invalid_move");
  assert.ok(err);
  assert.equal(err.payload.code, "ALREADY_ROLLED");
});

test("20. Six grants extra turn and 3 consecutive 6s forfeits turn to Player B", async () => {
  const session = mkFixtureSession({
    consecutiveSixes: 2,
    turnStatus: "WAITING_FOR_ROLL",
    gamePhase: "waiting_for_roll",
  });

  GameSession.findById = async () => session;
  secureRandom.rollDie = () => 6;

  const result = await gameService.rollDice(session.currentTurnPlayer, session._id);
  assert.equal(result.data.turnPassed, true);
  assert.equal(result.data.threeSixes, true);
  assert.equal(String(session.currentTurnPlayer), "6742d80b9a4f21001e3a9852");
  assert.equal(session.currentTurnSeat, 1);
});

test("21. No legal moves automatically advances the turn to next player", async () => {
  const session = mkFixtureSession({
    turnStatus: "WAITING_FOR_ROLL",
    gamePhase: "waiting_for_roll",
  });
  session.players[0].tokens = [
    { tokenId: 0, step: -1, isHome: false },
    { tokenId: 1, step: -1, isHome: false },
    { tokenId: 2, step: -1, isHome: false },
    { tokenId: 3, step: -1, isHome: false },
  ];

  GameSession.findById = async () => session;
  secureRandom.rollDie = () => 2; // non-6 cannot open base token

  const result = await gameService.rollDice(session.currentTurnPlayer, session._id);
  assert.equal(result.data.turnPassed, true);
  assert.equal(String(session.currentTurnPlayer), "6742d80b9a4f21001e3a9852");
  assert.equal(session.currentTurnSeat, 1);
});

test("22. Capture and goal events synchronize: capture resets opponent and grants extra turn", async () => {
  const session = mkFixtureSession({
    turnStatus: "WAITING_FOR_MOVE",
    gamePhase: "waiting_for_move",
    lastDiceValue: 2,
  });
  session.players[0].tokens[0].step = 15; // 15 + 2 = 17 on global board
  session.players[1].tokens[0].step = 4;  // 13 + 4 = 17 on global board (same non-safe square)

  GameSession.findById = async () => session;

  const result = await gameService.moveToken(session.currentTurnPlayer, session._id, 0);
  assert.ok(result.data.move.captured);
  assert.equal(result.data.move.getsExtraTurn, true);
  assert.equal(String(session.currentTurnPlayer), "6742d80b9a4f21001e3a9851"); // Retains turn
  assert.equal(session.players[1].tokens[0].step, 0); // Opponent token reset to base
});
