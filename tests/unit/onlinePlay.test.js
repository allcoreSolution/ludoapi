"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const socketManager = require("../../src/sockets/socketManager");

const mkState = (over = {}) => ({
  sessionId: "s1",
  status: "in_progress",
  turn: { userId: "u1", status: "WAITING_FOR_ROLL", movableTokenIds: [] },
  players: [
    { userId: "u1", seatIndex: 0, color: "Red", hasSurrendered: false },
    { userId: "u2", seatIndex: 1, color: "Green", hasSurrendered: false },
  ],
  ...over,
});

test("viewerView: player whose turn it is may roll, the opponent may not", () => {
  const st = mkState();
  const mine = socketManager.viewerView(st, "u1").me;
  assert.equal(mine.isMyTurn, true);
  assert.equal(mine.canRoll, true);
  assert.equal(mine.canMove, false);
  assert.equal(mine.color.toUpperCase(), "RED");

  const theirs = socketManager.viewerView(st, "u2").me;
  assert.equal(theirs.isMyTurn, false);
  assert.equal(theirs.canRoll, false);
  assert.equal(theirs.seatIndex, 1);
});

test("viewerView: after the roll only the roller can move, with the movable tokens", () => {
  const st = mkState({ turn: { userId: "u1", status: "WAITING_FOR_MOVE", movableTokenIds: [0, 2] } });
  const me = socketManager.viewerView(st, "u1").me;
  assert.equal(me.canRoll, false);
  assert.equal(me.canMove, true);
  assert.deepEqual(me.movableTokenIds, [0, 2]);
  assert.deepEqual(socketManager.viewerView(st, "u2").me.movableTokenIds, []);
});

test("viewerView: finished match and non-participants get no actions", () => {
  const done = mkState({ status: "completed" });
  assert.equal(socketManager.viewerView(done, "u1").me.canRoll, false);
  const outsider = socketManager.viewerView(mkState(), "nobody");
  assert.equal(outsider.me, undefined);
  assert.equal(socketManager.viewerView(null, "u1"), null);
});

test("gameRooms lists each channel once (no duplicate delivery)", () => {
  const rooms = socketManager.gameRooms({ _id: "abc", room: "room1" }, "room1");
  assert.deepEqual(rooms.sort(), ["game:abc", "game:room1", "session:abc"]);
});

test("formatSessionState reports real presence, not a hardcoded online:true", () => {
  const session = {
    _id: "s1",
    roomCode: "ABC123",
    status: "in_progress",
    currentTurnPlayer: "u1",
    currentTurnSeat: 0,
    turnStatus: "WAITING_FOR_ROLL",
    players: [{ user: "u1", name: "A", seatIndex: 0, color: "Red", tokens: [] }],
  };
  assert.equal(socketManager.formatSessionState(session).players[0].online, false);
});

test("broadcast helpers: timeout announces who missed, then the next turn", () => {
  const server = http.createServer();
  const io = socketManager.init(server);
  const sent = [];
  io.to = (rooms) => ({ emit: (event, payload) => sent.push({ rooms, event, payload }) });

  const session = {
    _id: "s1",
    room: "r1",
    roomCode: "ABC123",
    status: "in_progress",
    currentTurnPlayer: "u2",
    currentTurnSeat: 1,
    turnStatus: "WAITING_FOR_ROLL",
    history: [{ player: "u1", action: "TIMEOUT" }],
    players: [
      { user: "u1", name: "A", seatIndex: 0, color: "Red", missedTurns: 1, tokens: [] },
      { user: "u2", name: "B", seatIndex: 1, color: "Green", missedTurns: 0, tokens: [] },
    ],
  };

  socketManager.broadcastTimeoutResult(session, false);
  assert.deepEqual(sent.map((e) => e.event), ["turn_timeout", "turn_changed", "game_state"]);
  assert.equal(sent[0].payload.userId, "u1");
  assert.equal(sent[0].payload.missedTurns, 1);
  assert.equal(sent[1].payload.currentPlayerId, "u2");
  assert.equal(sent[1].payload.reason, "timeout");

  sent.length = 0;
  session.status = "completed";
  session.winner = "u2";
  session.settlement = { reason: "forfeit" };
  session.players[1].rank = 1;
  session.players[1].outcome = "win";
  session.players[1].prizeEarned = 90;
  socketManager.broadcastTimeoutResult(session, true);
  assert.deepEqual(sent.map((e) => e.event), ["turn_timeout", "game_over", "match_finished"]);
  const finished = sent.find((e) => e.event === "match_finished").payload;
  assert.equal(finished.winnerId, "u2");
  assert.equal(finished.reason, "forfeit");
  assert.equal(finished.ranking.find((r) => r.userId === "u2").prizeEarned, 90);

  server.close();
});

test("broadcast helpers do nothing (and never throw) for an empty session", () => {
  assert.equal(socketManager.broadcastMatchFinished(null), false);
  assert.equal(socketManager.broadcastTurnChanged(null), false);
});

test("routes: /api/games/active and /api/games/online/play are real routes (not read as a gameId)", async () => {
  const app = require("../../app");
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const a = await fetch(`${base}/api/games/active`);
    assert.equal(a.status, 401); // reaches auth, i.e. the route exists and is ahead of /:gameId
    const p = await fetch(`${base}/api/games/online/play`, { method: "POST" });
    assert.equal(p.status, 401);
    const d = await fetch(`${base}/api/games/online/play`, { method: "DELETE" });
    assert.equal(d.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
