// Express app, HTTP server and Socket.IO; static file serving
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { ROOT_DIR, PUBLIC_DIR, UPLOAD_DIR, PACKS_DIR } = require('./config');

const app = express();
const server = http.createServer(app);
// The page and the socket always share one origin, so other sites are not allowed to connect
const io = new Server(server);

// Pack media and takes never change at the same URL: let the browser cache them
// instead of downloading them through the tunnel again on every re-render
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h' }));
app.use('/packs', express.static(PACKS_DIR));
app.use(express.static(PUBLIC_DIR));
// Mediabunny (the MP4 muxer for WebCodecs rendering) is served straight from node_modules
app.use('/vendor/mediabunny', express.static(path.join(ROOT_DIR, 'node_modules', 'mediabunny', 'dist', 'bundles')));
app.use('/vendor/jszip', express.static(path.join(ROOT_DIR, 'node_modules', 'jszip', 'dist')));
app.use(express.json());
app.get('/favicon.ico', (req, res) => res.status(204).end());

module.exports = {
  app,
  server,
  io
};
