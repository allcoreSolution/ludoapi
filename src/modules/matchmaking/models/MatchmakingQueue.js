"use strict";

const mongoose = require("mongoose");
const { MODE_NAMES } = require("../../games/engine/ludoEngine");

const matchmakingQueueSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["waiting", "matched", "cancelled", "expired"],
      default: "waiting",
      required: true,
      index: true,
    },
    entryFee: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    gameMode: {
      type: String,
      required: true,
      enum: MODE_NAMES,
      default: "twoPlayer",
    },
    maxPlayers: {
      type: Number,
      required: true,
      default: 2,
      enum: [2, 3, 4],
    },
    matchedRoom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GameRoom",
      default: null,
    },
    matchedRoomCode: {
      type: String,
      default: null,
      trim: true,
    },
    opponent: {
      user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null,
      },
      name: {
        type: String,
        default: "",
        trim: true,
      },
      avatar: {
        type: String,
        default: "",
      },
    },
    queuedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    matchedAt: {
      type: Date,
      default: null,
    },
    cancelledAt: {
      type: Date,
      default: null,
    },
    expiredAt: {
      type: Date,
      default: null,
    },
    isEntryFeeDeducted: {
      type: Boolean,
      default: false,
    },
    isRefunded: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for atomic matchmaking queries (FIFO order for compatible opponents)
matchmakingQueueSchema.index({ status: 1, entryFee: 1, gameMode: 1, maxPlayers: 1, queuedAt: 1 });

// User active queue lookup (prevents duplicate waiting entries)
matchmakingQueueSchema.index({ user: 1, status: 1 });

// Fast cleanup index for the sweeper to detect expired waiting entries
matchmakingQueueSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model("MatchmakingQueue", matchmakingQueueSchema);
