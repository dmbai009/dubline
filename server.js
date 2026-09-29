// Точка входа Dubline: собирает модули из server/ и запускает HTTP-сервер
const { PORT } = require('./server/config');
const { app, server, io } = require('./server/app');
require('./server/rooms');   // загружает сохраненные комнаты
require('./server/routes');  // HTTP API
require('./server/sockets'); // Socket.IO
const { logEvent } = require('./server/log');
const { parseAssTime, parseSubtitles } = require('./server/parsers');
const { findEmbeddedSubtitleMap } = require('./server/media');
const { sanitizeRoomId, sanitizeNick } = require('./server/sanitize');

// start.bat просит открыть браузер, когда сервер реально готов (а не до старта, как раньше)
function openBrowser() {
  if (process.env.DUBLINE_OPEN_BROWSER !== '1') return;
  const url = `http://localhost:${PORT}`;
  const { exec } = require('child_process');
  const command = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(command, () => {});
}

if (require.main === module) {
  // Ошибка в одном обработчике не должна ронять игру у всех: пишем в журнал и работаем дальше
  process.on('uncaughtException', err => logEvent(null, `💥 Необработанная ошибка (сервер продолжает работу): ${err.stack || err}`, 'error'));
  process.on('unhandledRejection', err => logEvent(null, `💥 Необработанный промис (сервер продолжает работу): ${err && err.stack || err}`, 'error'));
  io.engine.on('connection_error', err => logEvent(null, `⚠ Не удалось подключить игрока: ${err.message}`, 'warn'));

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Dubline] Порт ${PORT} уже занят — похоже, сервер уже запущен в другом окне.`);
      console.error('[Dubline] Открываю страницу уже работающего сервера. Чтобы перезапустить сервер, закройте его окно и запустите start.bat снова.');
      openBrowser();
    } else {
      console.error('[Dubline] Сервер не смог запуститься:', err);
    }
    // Небольшая пауза, чтобы команда открытия браузера успела запуститься
    setTimeout(() => process.exit(1), 500);
  });

  server.listen(PORT, () => {
    console.log(`[Dubline] Сервер запущен: http://localhost:${PORT}`);
    console.log('[Dubline] Здесь будет журнал: кто зашел, кто вышел, ошибки и обрывы связи.');
    openBrowser();
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
