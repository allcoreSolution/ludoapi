"use strict";

module.exports = (req, res, next) => {
  const url = req.originalUrl || req.url || "";
  if (url.startsWith("/socket.io")) {
    return; // Never intercept Socket.IO polling or websocket requests in Express 404
  }
  res.status(404).json({
    success: false,
    message: "API Route Not Found",
    path: url.split("?")[0],
  });
};
