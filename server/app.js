// Express-приложение, HTTP-сервер и Socket.IO; раздача статических файлов
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { ROOT_DIR, PUBLIC_DIR, UPLOAD_DIR, PACKS_DIR } = require('./config');

const app = express();
const server = http.createServer(app);
// Страница и сокет всегда на одном адресе, поэтому чужим сайтам подключаться не разрешаем
const io = new Server(server);

// Медиа паков и дубли не меняются по одному адресу — пусть браузер кэширует их,
// а не перекачивает через туннель при каждой перерисовке
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h' }));
app.use('/packs', express.static(PACKS_DIR));
app.use(express.static(PUBLIC_DIR));
// Mediabunny (MP4-мультиплексор для рендера через WebCodecs) раздаем прямо из node_modules
app.use('/vendor/mediabunny', express.static(path.join(ROOT_DIR, 'node_modules', 'mediabunny', 'dist', 'bundles')));
app.use('/vendor/jszip', express.static(path.join(ROOT_DIR, 'node_modules', 'jszip', 'dist')));
app.use(express.json());
app.get('/favicon.ico', (req, res) => res.status(204).end());

module.exports = {
  app,
  server,
  io
};
