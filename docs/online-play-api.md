# Online Play (Login -> Play) - API & Socket guide

Rules the app can rely on: **the server rolls the dice**, validates every move, owns the turn
timer (15 s) and pays the prize. The app only asks ("roll", "move token X") and renders what
the server answers.

## 0. Seats and colours (matches the board in the app)

| seatIndex | colour | track offset |
|---|---|---|
| 0 (host / first turn) | Red | 0 |
| 1 | Green | 13 |
| 2 | Yellow | 26 |
| 3 | Blue | 39 |

Token `step`: `0` = in yard, `1..50` shared track (global tile = `(offset + step) % 52`),
`51..55` own home column, `56` = home. Every phone draws **itself at the bottom**: rotate the
board by `me.seatIndex`; the server always sends absolute seats.

## 1. Flow

```
POST /api/auth/login                      -> { user, token }
connect socket with  auth: { token }      -> may immediately get `active_game` (resume)
GET  /api/games/active                    -> in_game | in_room | in_queue | idle
POST /api/games/online/play {entryFee}    -> searching (201)  |  matched + started (200)  |  resumed (200)
   socket: match_found + match_started    -> both phones, each with its own state.me
loop:  roll_dice -> dice_roll_result -> move_token -> token_moved + turn_changed
socket: match_finished                    -> winner, ranking, prizeEarned
```

## 2. REST

| Method | Path | Notes |
|---|---|---|
| POST | `/api/games/online/play` | body `{ entryFee?: int, gameMode?: "twoPlayer" }`. One call: resumes what you are already doing, otherwise joins matchmaking. If an opponent is waiting, the match is **already started** (`autoStarted: true`, `sessionId`, `state`). |
| DELETE | `/api/games/online/play` | stop searching, entry fee refunded |
| GET | `/api/games/active` | call after login / app start. `status`: `in_game` (has `sessionId`, `me`, `game`), `in_room`, `in_queue`, `idle` |
| GET | `/api/matchmaking/status` | polling fallback; now includes `sessionId` once the match started, and goes back to `idle` when the match is over |
| GET | `/api/games/:gameId` | full state (`state.me` added) |
| POST | `/api/games/:gameId/reconnect` | state + tells the opponent you are back |
| POST | `/api/games/session/:id/surrender` | forfeit |

Existing endpoints (`/api/matchmaking/queue`, `/api/rooms/*`, `/api/games/create|join`,
REST `roll-dice` / `move-token`) are unchanged.

### `state.me` (what THIS player may do right now)
```json
{ "userId": "...", "seatIndex": 1, "color": "Green",
  "isMyTurn": true, "canRoll": true, "canMove": false, "movableTokenIds": [] }
```
Use `canRoll` to enable the dice, `movableTokenIds` to make tokens tappable.
The glowing red border in the UI = `state.turn.userId` (whose turn it is).

## 3. Socket events & Validated State Machine

### Game Phases (Server Authoritative)
- `waiting_for_roll`: Waiting for the active player to roll dice.
- `rolling_dice`: Server validating roll and generating dice value.
- `waiting_for_move`: Dice rolled, legal token moves calculated. Waiting for token selection.
- `moving_token`: Server validating and applying movement, capture, and goals.
- `turn_transition`: Transitioning between turns (or automatic pass if no moves).
- `game_over`: Game settled, prizes distributed, no further actions allowed.

### Client -> server events (all support ack `{ ok, data | code, message }`):
- `dice_roll_requested` (alias: `roll_dice`): `{ sessionId, actionId? }`
- `token_move_requested` (alias: `move_token`): `{ sessionId, tokenId, actionId? }`
- `join_session` / `join_game`: `{ sessionId }`
- `request_game_state`: `{ sessionId }`
- `turn_timeout`: `{ sessionId }`
- `surrender_match`: `{ sessionId }`

### Server -> client events:

| Event | When | Key fields |
|---|---|---|
| `active_game` | right after the socket connects, if a match is running | `sessionId`, `state` (with `me`) |
| `game_started` / `match_started` | match start | `roomId`, `sessionId`, `matchId`, `gamePhase`, `state` |
| `dice_roll_result` (also `dice_rolled`) | dice rolled | `roomId`, `playerId`, `diceValue`, `legalMoves`, `movableTokenIds`, `turnPassed`, `threeSixes`, `turnNumber`, `stateVersion`, `gamePhase`, `state` |
| `token_moved` | token moved | `roomId`, `playerId`, `tokenId`, `move`, `turnNumber`, `stateVersion`, `gamePhase`, `state` |
| `turn_changed` | next turn or extra turn | `roomId`, `currentPlayerId`, `getsExtraTurn`, `turnNumber`, `stateVersion`, `gamePhase`, `turn`, `state` |
| `invalid_move` / `game_error` | rejected move / out of turn | `code`, `message`, `playerId`, `actionId` |
| `turn_timeout` | player missed 15s timer | `userId`, `missedTurns`, `state` |
| `player_disconnected` / `player_reconnected` | player disconnect/reconnect | `userId`, `playerId`, `state` |
| `game_over` / `match_finished` | match finished | `winnerId`, `reason`, `ranking`, `gamePhase: "game_over"`, `state` |
| `game_state` | full state snapshot | `roomId`, `sessionId`, `state`, `gameState` |

Each event is now delivered **once** per phone (before, a phone that joined both the `session:`
and `game:` channel got `dice_roll_result` twice -> dice animated twice).

## 4. Flutter (socket_io_client) - dice + move

```dart
final socket = IO.io(baseUrl, IO.OptionBuilder()
    .setTransports(['websocket']).setAuth({'token': jwt}).disableAutoConnect().build());
socket.connect();

int lastVersion = -1;                       // ignore stale snapshots
bool accept(Map st) { final v = st['stateVersion'] as int; if (v < lastVersion) return false; lastVersion = v; return true; }

void onDiceTap() {                          // dice button
  if (!me.canRoll) return;
  startDiceSpin();
  socket.emitWithAck('roll_dice', {'sessionId': sessionId}, ack: (r) {
    if (r['ok'] != true) stopDiceSpin();    // e.g. not your turn
  });
}

socket.on('dice_roll_result', (d) {         // BOTH phones: show the SERVER's number
  stopDiceSpin(showValue: d['diceValue'], player: d['playerId']);
  if (d['playerId'] == myId && d['turnPassed'] != true) {
    final ids = List<int>.from(d['movableTokenIds']);
    if (ids.length == 1) onTokenTap(ids.first);   // optional auto-move, like vs-computer
    else highlightTokens(ids);
  }
});

void onTokenTap(int tokenId) =>
    socket.emitWithAck('move_token', {'sessionId': sessionId, 'tokenId': tokenId}, ack: (_) {});

socket.on('token_moved', (d) => animateToken(d['playerId'], d['move']));   // prevStep -> newStep
socket.on('turn_changed', (d) { if (accept(d['state'])) applyState(d['state']); }); // moves the red glow
socket.on('match_finished', (d) => showResult(d['ranking']));
socket.on('active_game', (d) => openGame(d['sessionId'], d['state']));      // resume
```
