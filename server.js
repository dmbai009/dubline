// Dubline entry point: wires the modules from server/ together and starts the HTTP server
const { PORT } = require('./server/config');
const nativeProjectSaves = new Map();
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
  require('./server/orphanGc').start();

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

  // Bind all IPv4 interfaces so Porthole and private VPN adapters can reach the host.
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Dubline] Server started: http://localhost:${PORT}`);
    console.log('[Dubline] The event log appears here: who joined, who left, errors and dropped connections.');
    if (typeof process.send === 'function') process.send({ type: 'ready', port: Number(PORT) });
    openBrowser();
  });

  process.on('message', message => {
    if (message?.type === 'desktop-busy') {
      const busy = require('./server/routes').isMediaBusy() || require('./server/project-save').isBusy() || require('./server/snapshotBarrier').isBusy() || Object.values(require('./server/state').recordingNow).some(lines => Object.keys(lines).length > 0);
      process.send?.({ requestId: message.requestId, ok: true, busy }); return;
    }
    if (message?.type === 'cancel-project-save') {
      const job=nativeProjectSaves.get(message.ticket);
      const canceled=!!job && job.stage!=='committing';
      if(canceled)job.controller.abort();
      process.send?.({requestId:message.requestId,ok:true,canceled});return;
    }
    if (message?.type === 'save-project-file') {
      const job={controller:new AbortController(),stage:'preparing'};
      nativeProjectSaves.set(message.ticket,job);
      (async () => {
        const roomId = require('./server/desktop').desktopRoomId, room = require('./server/rooms').getRoom(roomId);
        if (!require('./server/auth').isHost(room, message.clientId) || message.sessionId !== room.activeSessionId) throw new Error('The scene or host rights changed.');
        const snapshot = require('./server/snapshotBarrier').capture(roomId, message.clientId, message.barrierToken, 'project', message.forceSnapshot === true);
        const saved = await require('./server/project-save').saveProjectFile(snapshot, message.destination, {
          signal:job.controller.signal, onProgress:progress=>{ job.stage=progress.stage;process.send?.({type:'project-save-progress',requestId:message.requestId,progress}); }
        });
        process.send?.({ requestId: message.requestId, ok: true, ...saved });
      })().catch(error => process.send?.({ requestId: message.requestId, ok: false, canceled:error.name==='AbortError', error:error.name==='AbortError'?'Project saving canceled.':'Project could not be saved. Check the destination and free disk space.' }))
        .finally(()=>nativeProjectSaves.delete(message.ticket));
      return;
    }
    if (message?.type === 'new-single-project' || message?.type === 'enable-multiplayer' || message?.type === 'open-project-file') {
      (async () => {
        if (message.type === 'new-single-project') {
          const { getRoom, snapshotActive, activateSession, flushRooms } = require('./server/rooms');
          const room = getRoom(require('./server/desktop').desktopRoomId);
          snapshotActive(room); activateSession(room, null); flushRooms();
        } else if (message.type === 'enable-multiplayer') require('./server/desktop').enableMultiplayer();
        else {
          const fs = require('fs');
          const stat = fs.statSync(message.path);
          if (!stat.isFile() || !stat.size) throw new Error('Invalid project file.');
          await require('./server/routes').importProjectIntoRoom(require('./server/desktop').desktopRoomId, message.path);
        }
        process.send?.({ requestId: message.requestId, ok: true });
      })().catch(error => process.send?.({ requestId: message.requestId, ok: false, error: error.message }));
      return;
    }
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
