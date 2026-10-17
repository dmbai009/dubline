const { roomSockets, p2pSeeders } = require('../state');
const { io } = require('../app');
const { logEvent } = require('../log');
const { getRoom } = require('../rooms');
const { clearSocketSeeds, broadcastSeeders } = require('../presence');

module.exports = function registerP2pHandlers(socket, conn) {
  const member = data => data && typeof data === 'object' && !Array.isArray(data) && conn.nick && roomSockets[conn.roomId]?.[socket.id]?.nick === conn.nick &&
    !getRoom(conn.roomId).singlePlayer && (data?.sessionId === undefined || data.sessionId === getRoom(conn.roomId).activeSessionId);
  // ---------- P2P video sharing between players ----------
  // The server only introduces players: video pieces go directly browser to browser (WebRTC)
  socket.on('p2p_have', async (data = {}) => {
    if (!member(data)) return;
    const room = getRoom(conn.roomId);
    try { if (!await require('../mediaAvailability').update(socket, conn, data)) return; } catch { return; }
    const byUrl = p2pSeeders[conn.roomId] || (p2pSeeders[conn.roomId] = {});
    clearSocketSeeds(conn.roomId, socket.id);
    data.files.filter(file => file.ranges.length && require('../mediaAvailability').allowed(room).has(file.url)).forEach(({ url }) => {
      (byUrl[url] || (byUrl[url] = new Set())).add(socket.id);
    });
    broadcastSeeders(conn.roomId);
  });

  socket.on('p2p_find', (data = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (!member(data)) return ack([]);
    const { url, detailed } = data;
    const peers = require('../mediaAvailability').peers(conn.roomId, url, socket.id);
    ack(detailed === true ? peers.slice(0, 32) : peers.map(peer => peer.socketId));
  });

  socket.on('p2p_signal', (message = {}) => {
    if (!member(message)) return;
    const { to, data } = message;
    if (typeof to !== 'string' || !roomSockets[conn.roomId]?.[to]?.nick) return;
    if (!data || !['offer', 'answer', 'candidate'].includes(data.kind) || JSON.stringify(data).length > 32768) return;
    io.to(to).emit('p2p_signal', { from: socket.id, sessionId: getRoom(conn.roomId).activeSessionId, data });
  });

  socket.on('p2p_report', (data = {}) => {
    if (!member(data)) return;
    const { url, p2pBytes, httpBytes, peers } = data;
    if (!require('../mediaAvailability').allowed(getRoom(conn.roomId)).has(url) ||
      ![p2pBytes, httpBytes].every(bytes => Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= 24 * 1024 ** 3) ||
      !Number.isInteger(peers) || peers < 0 || peers > 3) return;
    const mb = bytes => (Math.max(0, Number(bytes) || 0) / 1048576).toFixed(1);
    const raw = String(url || '').split('/').pop() || 'file';
    let name = raw;
    try { name = decodeURIComponent(raw); } catch (err) { /* malformed escape from a client: log it as is */ }
    logEvent(conn.roomId, `⚡ ${conn.nick || 'player'} received ${name}: ${mb(p2pBytes)} MB from players (${Number(peers) || 0}), ${mb(httpBytes)} MB from the server`);
  });
};
