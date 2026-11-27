"use strict";

const config = require("../../../../config/env");
const GameRoom = require("../models/GameRoom");

const DEFAULT_INVITE_HOST = "https://ludoapi-jupm.onrender.com";

/**
 * Escapes HTML characters to prevent XSS in rendered templates.
 */
const escapeHtml = (str) => {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

/**
 * Evaluates the live availability of a room by room code.
 */
const checkRoomAvailability = async (rawCode) => {
  const code = String(rawCode || "").trim().toUpperCase();

  if (!code || code.length !== 6 || !/^[A-Z0-9]{6}$/.test(code)) {
    return {
      success: false,
      roomCode: code,
      roomExists: false,
      status: null,
      isJoinable: false,
      isFull: false,
      currentPlayers: 0,
      maxPlayers: 0,
      availableSlots: 0,
      gameStarted: false,
      roomExpired: false,
      message: "Invalid room code format. Must be 6 alphanumeric characters.",
    };
  }

  const room = await GameRoom.findOne({ roomCode: code }).lean();

  if (!room) {
    return {
      success: false,
      roomCode: code,
      roomExists: false,
      status: null,
      isJoinable: false,
      isFull: false,
      currentPlayers: 0,
      maxPlayers: 0,
      availableSlots: 0,
      gameStarted: false,
      roomExpired: false,
      message: "Room not found",
    };
  }

  const currentPlayers = Array.isArray(room.players) ? room.players.length : 0;
  const maxPlayers = Number(room.maxPlayers) || 2;
  const availableSlots = Math.max(0, maxPlayers - currentPlayers);
  const isFull = availableSlots === 0;

  const ttlMinutes = config.economy?.roomWaitingTtlMinutes || 30;
  const isStale =
    (room.status === "waiting" || room.status === "starting") &&
    room.updatedAt &&
    Date.now() - new Date(room.updatedAt).getTime() > ttlMinutes * 60_000;

  const roomExpired = room.status === "cancelled" || isStale;
  const gameStarted = ["starting", "playing", "finished"].includes(room.status);
  const isJoinable = room.status === "waiting" && !isFull && !roomExpired;

  let message = "Room is available to join";
  if (room.status === "cancelled") {
    message = "Room was cancelled";
  } else if (roomExpired) {
    message = "Room has expired";
  } else if (room.status === "finished") {
    message = "Game has already finished";
  } else if (gameStarted) {
    message = "Game has already started";
  } else if (isFull) {
    message = "Room is full";
  }

  return {
    success: true,
    roomCode: code,
    roomExists: true,
    status: room.status,
    isJoinable,
    isFull,
    currentPlayers,
    maxPlayers,
    availableSlots,
    gameStarted,
    roomExpired,
    message,
    entryFee: Number(room.entryFee) || 0,
    gameMode: room.gameMode || "twoPlayer",
  };
};

/**
 * Builds formatted invitation message and social share metadata.
 */
const buildShareTemplate = ({ roomCode, entryCoins, gameMode, inviteUrl, req }) => {
  const code = roomCode ? String(roomCode).trim().toUpperCase() : "";
  const coins = entryCoins !== undefined && entryCoins !== null && String(entryCoins).trim() !== ""
    ? Number(entryCoins)
    : null;

  let defaultBaseUrl = DEFAULT_INVITE_HOST;
  if (req && typeof req.get === "function") {
    const proto = req.get("x-forwarded-proto") || req.protocol || "https";
    const host = req.get("host");
    if (host) defaultBaseUrl = `${proto}://${host}`;
  }

  const finalInviteUrl = inviteUrl
    ? String(inviteUrl).trim().replace(/^(https?):\/([^\/])/, "$1://$2")
    : code
    ? `${defaultBaseUrl}/invite/${code}`
    : `${defaultBaseUrl}/invite`;

  let formattedMessage = null;
  if (code) {
    const lines = [
      "🎲 Ludo Supreme Match Invitation! 🏆",
      "",
      "Join my Ludo match!",
      "",
      `🔑 Room Code: ${code}`,
    ];

    if (coins !== null && !Number.isNaN(coins)) {
      lines.push(`🪙 Entry: ${coins > 0 ? `${coins} Coins` : "Free"}`);
    }

    if (gameMode) {
      const modeLabel =
        gameMode === "twoPlayer" ? "2 Players" :
        gameMode === "threePlayer" ? "3 Players" :
        gameMode === "fourPlayer" ? "4 Players" : String(gameMode);
      lines.push(`🎮 Mode: ${modeLabel}`);
    }

    lines.push(
      "",
      "📲 How to Join:",
      "1. Open Ludo Supreme.",
      "2. Tap Join Room.",
      "3. Enter Room Code.",
      "",
      "🔗 Join directly:",
      finalInviteUrl,
      "",
      "Let's play!"
    );

    formattedMessage = lines.join("\n");
  }

  return {
    success: true,
    data: {
      appName: "Ludo Supreme",
      title: "Ludo Supreme Match Invitation",
      messageTemplate: "Join my Ludo match!",
      roomCode: code || null,
      entryCoins: coins,
      gameMode: gameMode || null,
      inviteUrl: finalInviteUrl,
      deepLinkUrl: code ? `ludosupreme://join?code=${code}` : "ludosupreme://join",
      shareMessage: formattedMessage,
      instructions: [
        "Open Ludo Supreme",
        "Tap Join Room",
        "Enter the room code",
      ],
      hashtags: ["#LudoSupreme", "#Ludo", "#OnlineLudo"],
    },
  };
};

/**
 * Generates responsive, branded HTML landing page for room invitations.
 */
const generateInviteHtml = (availability, req) => {
  const code = escapeHtml(availability.roomCode || "");
  const status = availability.status || "not_found";
  const isJoinable = Boolean(availability.isJoinable);
  const message = escapeHtml(availability.message || "Room Status");
  const deepLink = code ? `ludosupreme://join?code=${encodeURIComponent(code)}` : "ludosupreme://";
  const playStoreUrl = "https://play.google.com/store/apps/details?id=com.ludosupreme.game";

  let statusBadgeClass = "badge-success";
  let statusBadgeText = "JOINABLE";

  if (!availability.roomExists) {
    statusBadgeClass = "badge-danger";
    statusBadgeText = "NOT FOUND";
  } else if (availability.roomExpired) {
    statusBadgeClass = "badge-warning";
    statusBadgeText = "EXPIRED";
  } else if (availability.isFull) {
    statusBadgeClass = "badge-warning";
    statusBadgeText = "ROOM FULL";
  } else if (availability.gameStarted) {
    statusBadgeClass = "badge-info";
    statusBadgeText = "MATCH STARTED";
  }

  const autoRedirectScript = isJoinable
    ? `
      <script>
        setTimeout(function() {
          try {
            window.location.href = "${deepLink}";
          } catch(e) {}
        }, 500);
      </script>
    `
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Ludo Supreme — Match Invitation ${code ? `(${code})` : ""}</title>
  
  <!-- Social Media Metadata -->
  <meta property="og:title" content="Ludo Supreme Match Invitation ${code ? `• Code: ${code}` : ""}">
  <meta property="og:description" content="${isJoinable ? `Join room ${code} now! ${availability.availableSlots || 0} slot(s) left. Tap to play!` : message}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Ludo Supreme — Join Room ${code}">
  <meta name="twitter:description" content="${message}">
  <meta name="theme-color" content="#1a102f">

  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    body {
      background: radial-gradient(circle at top, #2b124c 0%, #120b22 100%);
      color: #ffffff;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      backdrop-filter: blur(12px);
      border-radius: 24px;
      width: 100%;
      max-width: 420px;
      padding: 32px 24px;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
    }
    .brand-logo {
      width: 72px;
      height: 72px;
      background: linear-gradient(135deg, #ff416c, #ff4b2b);
      border-radius: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 38px;
      margin-bottom: 16px;
      box-shadow: 0 8px 16px rgba(255, 65, 108, 0.35);
    }
    h1 {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.5px;
      margin-bottom: 6px;
      background: linear-gradient(90deg, #fff, #ffd200);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      color: #b3a7d6;
      font-size: 14px;
      margin-bottom: 24px;
    }
    .badge {
      display: inline-block;
      padding: 5px 14px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin-bottom: 16px;
    }
    .badge-success { background: rgba(38, 222, 129, 0.2); color: #26de81; border: 1px solid #26de81; }
    .badge-warning { background: rgba(254, 211, 48, 0.2); color: #fed330; border: 1px solid #fed330; }
    .badge-danger { background: rgba(252, 92, 101, 0.2); color: #fc5c65; border: 1px solid #fc5c65; }
    .badge-info { background: rgba(69, 170, 242, 0.2); color: #45aaf2; border: 1px solid #45aaf2; }
    
    .room-box {
      background: rgba(0, 0, 0, 0.35);
      border: 2px dashed rgba(255, 215, 0, 0.35);
      border-radius: 16px;
      padding: 16px;
      margin-bottom: 20px;
    }
    .room-label {
      font-size: 11px;
      color: #a49bc7;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      margin-bottom: 6px;
    }
    .room-code {
      font-size: 32px;
      font-weight: 900;
      letter-spacing: 6px;
      color: #ffd200;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat-item {
      background: rgba(255, 255, 255, 0.04);
      border-radius: 12px;
      padding: 10px;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .stat-val {
      font-size: 16px;
      font-weight: 700;
      color: #fff;
    }
    .stat-lbl {
      font-size: 11px;
      color: #9c8eb9;
      margin-top: 2px;
    }
    .btn {
      display: block;
      width: 100%;
      padding: 14px 20px;
      border-radius: 14px;
      font-size: 16px;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
      border: none;
      transition: all 0.2s ease;
    }
    .btn-primary {
      background: linear-gradient(135deg, #05c46b, #0be881);
      color: #0b1a0d;
      box-shadow: 0 8px 20px rgba(11, 232, 129, 0.35);
      margin-bottom: 12px;
    }
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 24px rgba(11, 232, 129, 0.45);
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.15);
      margin-bottom: 12px;
    }
    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.15);
    }
    .message-banner {
      background: rgba(255, 255, 255, 0.06);
      border-radius: 12px;
      padding: 12px;
      font-size: 13px;
      color: #dfd8f5;
      margin-bottom: 20px;
    }
    .footer-note {
      font-size: 12px;
      color: #7b7194;
      margin-top: 18px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand-logo">🎲</div>
    <h1>Ludo Supreme</h1>
    <p class="subtitle">Online Multiplayer Board Game</p>

    <div class="badge ${statusBadgeClass}">${statusBadgeText}</div>

    ${code ? `
      <div class="room-box">
        <div class="room-label">Room Code</div>
        <div class="room-code">${code}</div>
      </div>
    ` : ""}

    ${availability.roomExists ? `
      <div class="stats-grid">
        <div class="stat-item">
          <div class="stat-val">${availability.currentPlayers || 0} / ${availability.maxPlayers || 2}</div>
          <div class="stat-lbl">Players</div>
        </div>
        <div class="stat-item">
          <div class="stat-val">${availability.entryFee ? `${availability.entryFee} 🪙` : "Free"}</div>
          <div class="stat-lbl">Entry Fee</div>
        </div>
      </div>
    ` : ""}

    <div class="message-banner">
      ${message}
    </div>

    ${isJoinable ? `
      <a href="${deepLink}" class="btn btn-primary" id="joinBtn">Open Game &amp; Join</a>
      <button class="btn btn-secondary" onclick="copyCode('${code}')" id="copyBtn">📋 Copy Room Code</button>
    ` : `
      <a href="${deepLink}" class="btn btn-secondary">Open Ludo Supreme</a>
    `}

    <a href="${playStoreUrl}" class="btn btn-secondary" style="font-size: 13px; padding: 10px;">
      📲 Download Ludo Supreme App
    </a>

    <div class="footer-note">
      Play with real players anytime, anywhere.
    </div>
  </div>

  <script>
    function copyCode(code) {
      if (!code) return;
      navigator.clipboard.writeText(code).then(function() {
        var btn = document.getElementById('copyBtn');
        if (btn) {
          btn.innerText = '✅ Code Copied!';
          setTimeout(function() { btn.innerText = '📋 Copy Room Code'; }, 2000);
        }
      }).catch(function() {
        alert('Room code: ' + code);
      });
    }
  </script>
  ${autoRedirectScript}
</body>
</html>`;
};

module.exports = {
  checkRoomAvailability,
  buildShareTemplate,
  generateInviteHtml,
};
