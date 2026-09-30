// Dubline entry point: wires the modules from server/ together and starts the HTTP server
const { PORT } = require('./server/config');
const { app, server, io } = require('./server/app');
const { flushRooms } = require('./server/rooms'); // loads saved rooms
const { configureDesktopRoom } = require('./server/desktop');
require('./server/routes');  // HTTP API
require('./server/sockets'); // Socket.IO
const { logEvent } = require('./server/log');
const { parseAssTime, parseSubtitles } = require('./server/parsers');
const { findEmbeddedSubtitleMap } = require('./server/media');
const { sanitizeRoomId, sanitizeNick } = require('./server/sanitize');

// start.bat asks to open the browser once the server is actually ready (not before it starts, as it used to)
function openBrowser() {
  if (process.env.DUBLINE_OPEN_BROWSER !== '1') return;
  const url = `http://localhost:${PORT}`;
  const { exec } = require('child_process');
  const command = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(command, () => {});
}

if (require.main === module) {
  configureDesktopRoom();

  // An error in one handler must not take the game down for everyone: log it and keep running
  process.on('uncaughtException', err => logEvent(null, `💥 Unhandled error (the server keeps running): ${err.stack || err}`, 'error'));
  process.on('unhandledRejection', err => logEvent(null, `💥 Unhandled promise rejection (the server keeps running): ${err && err.stack || err}`, 'error'));
  io.engine.on('connection_error', err => logEvent(null, `⚠ Could not connect a player: ${err.message}`, 'warn'));

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Dubline] Port ${PORT} is already in use: the server seems to be running in another window.`);
      console.error('[Dubline] Opening the page of the running server. To restart the server, close its window and run start.bat again.');
      openBrowser();
    } else {
      console.error('[Dubline] The server could not start:', err);
    }
    // A short pause so the command that opens the browser has time to start
    setTimeout(() => process.exit(1), 500);
  });

  server.listen(PORT, () => {
    console.log(`[Dubline] Server started: http://localhost:${PORT}`);
    console.log('[Dubline] The event log appears here: who joined, who left, errors and dropped connections.');
    if (typeof process.send === 'function') process.send({ type: 'ready', port: Number(PORT) });
    openBrowser();
  });

  process.on('message', message => {
    if (!message || message.type !== 'shutdown') return;
    flushRooms();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

module.exports = {
  app,
  server,
  parseAssTime,
  parseSubtitles,
  findEmbeddedSubtitleMap,
  sanitizeRoomId,
  sanitizeNick
};
