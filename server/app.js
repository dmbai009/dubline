// Express app, HTTP server and Socket.IO; static file serving
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { ROOT_DIR, PUBLIC_DIR, UPLOAD_DIR, PACKS_DIR } = require('./config');
const { mediaAccessGate } = require('./desktop');

const app = express();
const server = http.createServer(app);
// The page and the socket always share one origin, so other sites are not allowed to connect
const io = new Server(server);
let activeHttpRequests = 0;
app.use((req, res, next) => {
  activeHttpRequests++; let finished = false;
  const done = () => { if (!finished) { finished = true; activeHttpRequests--; } };
  res.once('finish', done); res.once('close', done); next();
});
app.use(require('./textCompression').textCompression);

// Browsers must not guess a script or page out of an uploaded file
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// Uploaded files come from players: even if one is opened directly as a page,
// it runs in a sandbox without access to Dubline's origin (its localStorage and cookies)
function sandboxUploads(req, res, next) {
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  next();
}

// Pack media and takes never change at the same URL: let the browser cache them
// instead of downloading them through the tunnel again on every re-render.
// In the desktop app only the host and players who entered the PIN can fetch them.
app.use(['/uploads', '/packs', '/api/server-packs', '/api/audio-waveform'], mediaAccessGate);
// Source video stays on the host. Only the server's export path reads it.
app.use('/uploads', (req, res, next) => {
  if (/^source_video(?:_\d+)?\.(mp4|mkv|webm)$/i.test(path.basename(decodeURIComponent(req.path)))) return res.sendStatus(403);
  next();
});
app.use('/uploads', sandboxUploads, express.static(UPLOAD_DIR, { maxAge: '1h' }));
app.use('/packs', sandboxUploads, express.static(PACKS_DIR));
app.use(express.static(PUBLIC_DIR));
// Mediabunny (the MP4 muxer for WebCodecs rendering) is served straight from node_modules
app.use('/vendor/mediabunny', express.static(path.join(ROOT_DIR, 'node_modules', 'mediabunny', 'dist', 'bundles')));
app.use('/vendor/jszip', express.static(path.join(ROOT_DIR, 'node_modules', 'jszip', 'dist')));
app.use(express.json());
app.get('/favicon.ico', (req, res) => res.status(204).end());

module.exports = {
  app,
  server,
  io,
  isHttpBusy: () => activeHttpRequests > 0
};
