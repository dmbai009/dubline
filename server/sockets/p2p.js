const { roomSockets, p2pSeeders } = require('../state');
const { io } = require('../app');
const { logEvent } = require('../log');
const { getRoom } = require('../rooms');
const { clearSocketSeeds, broadcastSeeders } = require('../presence');

module.exports = function registerP2pHandlers(socket, conn) {
  // ---------- P2P-раздача видео между игроками ----------
  // Сервер только сводит игроков: сами куски видео идут напрямую браузер-браузер (WebRTC)
  socket.on('p2p_have', ({ urls } = {}) => {
    if (!conn.roomId || !Array.isArray(urls)) return;
    const room = getRoom(conn.roomId);
    const allowed = new Set([room.videoUrl, room.backingUrl].filter(Boolean));
    const byUrl = p2pSeeders[conn.roomId] || (p2pSeeders[conn.roomId] = {});
    clearSocketSeeds(conn.roomId, socket.id);
    urls.filter(url => allowed.has(url)).forEach(url => {
      (byUrl[url] || (byUrl[url] = new Set())).add(socket.id);
    });
    broadcastSeeders(conn.roomId);
  });

  socket.on('p2p_find', ({ url } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (!conn.roomId) return ack([]);
    const ids = [...((p2pSeeders[conn.roomId] || {})[url] || [])].filter(id => id !== socket.id);
    ack(ids);
  });

  socket.on('p2p_signal', ({ to, data } = {}) => {
    if (!conn.roomId || typeof to !== 'string' || !roomSockets[conn.roomId] || !roomSockets[conn.roomId][to]) return;
    io.to(to).emit('p2p_signal', { from: socket.id, data });
  });

  socket.on('p2p_report', ({ url, p2pBytes, httpBytes, peers } = {}) => {
    if (!conn.roomId) return;
    const mb = bytes => (Math.max(0, Number(bytes) || 0) / 1048576).toFixed(1);
    const name = decodeURIComponent(String(url || '').split('/').pop() || 'файл');
    logEvent(conn.roomId, `⚡ ${conn.nick || 'игрок'} получил ${name}: ${mb(p2pBytes)} МБ от игроков (${Number(peers) || 0}), ${mb(httpBytes)} МБ с сервера`);
  });
};
