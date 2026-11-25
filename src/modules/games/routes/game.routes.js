const express = require("express");
const router = express.Router();

const { protect } = require("../../../../middleware/auth.middleware");
const { gameActionLimiter, matchmakingLimiter } = require("../../../../middleware/rateLimit.middleware");

const {
  startGameSession,
  getGameSession,
  rollDice,
  moveToken,
  handleTurnTimeout,
  surrenderMatch,
  completeGameSession,
  getMyGameHistory,
  createMatch,
  joinMatch,
  getGameState,
  getActiveGame,
  playOnline,
  cancelOnline,
  reconnectMatch,
} = require("../controllers/game.controller");

const {
  validateRequest,
  startGameValidation,
  sessionIdParamValidation,
  moveTokenValidation,
  historyQueryValidation,
  createMatchValidation,
  joinMatchValidation,
  gameIdParamValidation,
} = require("../validations/game.validation");
const { joinQueueValidation } = require("../../matchmaking/validations/matchmaking.validation");

// ==========================================
// Online Play (login -> play): resume + one-call matchmaking
// (declared before "/:gameId" so "active" / "online" are not read as a game id)
// ==========================================
router.get("/active", protect, getActiveGame);

router.post(
  "/online/play",
  protect,
  matchmakingLimiter,
  joinQueueValidation,
  validateRequest,
  playOnline
);

router.delete("/online/play", protect, matchmakingLimiter, cancelOnline);

// ==========================================
// Online Match: Create Match
// ==========================================
router.post(
  "/create",
  protect,
  createMatchValidation,
  validateRequest,
  createMatch
);

// ==========================================
// Online Match: Join Match
// ==========================================
router.post(
  "/join",
  protect,
  joinMatchValidation,
  validateRequest,
  joinMatch
);

// ==========================================
// 1. Start / Initialize Game Session
// ==========================================
router.post(
  "/start",
  protect,
  startGameValidation,
  validateRequest,
  startGameSession
);

// ==========================================
// 2. Get Player Match History
// (Placed before :sessionId to avoid routing conflict)
// ==========================================
router.get(
  "/history/my-games",
  protect,
  historyQueryValidation,
  validateRequest,
  getMyGameHistory
);

// ==========================================
// 3. Get Active Game Session Live State
// ==========================================
router.get(
  "/session/:sessionId",
  protect,
  sessionIdParamValidation,
  validateRequest,
  getGameSession
);

// ==========================================
// 4. Roll Dice
// ==========================================
router.post(
  "/session/:sessionId/roll-dice",
  protect,
  gameActionLimiter,
  sessionIdParamValidation,
  validateRequest,
  rollDice
);

// ==========================================
// 5. Move Token & Update Score
// ==========================================
router.post(
  "/session/:sessionId/move-token",
  protect,
  gameActionLimiter,
  moveTokenValidation,
  validateRequest,
  moveToken
);

// ==========================================
// 6. Handle Turn Timeout
// ==========================================
router.post(
  "/session/:sessionId/timeout",
  protect,
  gameActionLimiter,
  sessionIdParamValidation,
  validateRequest,
  handleTurnTimeout
);

// ==========================================
// 7. Surrender / Forfeit Match
// ==========================================
router.post(
  "/session/:sessionId/surrender",
  protect,
  sessionIdParamValidation,
  validateRequest,
  surrenderMatch
);

// ==========================================
// 8. Complete & Settle Match
// ==========================================
router.post(
  "/session/:sessionId/complete",
  protect,
  sessionIdParamValidation,
  validateRequest,
  completeGameSession
);

// ==========================================
// 9. Reconnect Match (POST /api/games/:gameId/reconnect)
// ==========================================
router.post(
  "/:gameId/reconnect",
  protect,
  gameIdParamValidation,
  validateRequest,
  reconnectMatch
);

// ==========================================
// 10. Get Game State (GET /api/games/:gameId)
// ==========================================
router.get(
  "/:gameId",
  protect,
  gameIdParamValidation,
  validateRequest,
  getGameState
);

module.exports = router;
