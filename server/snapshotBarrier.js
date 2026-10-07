// Ephemeral coordination only. No barrier token or readiness enters a project/autosave.
const { randomUUID } = require('node:crypto');
const { roomSockets } = require('./state');
const barriers = new Map();
const reasons = new Set(['pending', 'conflict', 'draft', 'gesture', 'recording', 'upload', 'resync', 'disconnected', 'timeout', 'ready']);
function view(barrier) {
  return { token: barrier.token, sessionId: barrier.sessionId, purpose: barrier.purpose, deadline: barrier.deadline,
    finished: [...barrier.members.values()].every(member => member.reason !== 'waiting') || Date.now() >= barrier.deadline,
    participants: [...barrier.members].map(([socketId, member]) => ({ socketId, nick: member.nick, reason: member.reason })) };
}
function release(barrier) {
  if (!barriers.delete(barrier.token)) return;
  require('./app').io.to(barrier.roomId).emit('snapshot_release', { token: barrier.token, sessionId: barrier.sessionId });
}
function check(barrier) {
  const room = require('./rooms').getRoom(barrier.roomId);
  if (barrier.expires <= Date.now() || room.activeSessionId !== barrier.sessionId || room.hostClientId !== barrier.clientId || !roomSockets[barrier.roomId]?.[barrier.hostSocket]) { release(barrier); return false; }
  for (const [socketId, member] of barrier.members) {
    if (!roomSockets[barrier.roomId]?.[socketId]) member.reason = 'disconnected';
    else if (member.reason === 'waiting' && Date.now() >= barrier.deadline) member.reason = 'timeout';
  }
  return true;
}
function frozen(roomId, socketId) {
  for (const barrier of barriers.values()) if (barrier.roomId === roomId && check(barrier) && barrier.members.get(socketId)?.reason === 'ready') return true;
  return false;
}
function blocked(socket, conn) { return frozen(conn.roomId, socket.id) ? { ok: false, reason: 'snapshot' } : null; }
function frozenClient(roomId, sessionId, clientId) {
  return Object.entries(roomSockets[roomId] || {}).some(([socketId, member]) => member.clientId === clientId && require('./rooms').getRoom(roomId).activeSessionId === sessionId && frozen(roomId, socketId));
}
function start(socket, conn, data) {
  const room = require('./rooms').getRoom(conn.roomId);
  if (!roomSockets[conn.roomId]?.[socket.id] || room.hostClientId !== conn.clientId || data.sessionId !== room.activeSessionId || !['project', 'voxalike', 'archive'].includes(data.purpose)) return { ok: false, reason: 'session' };
  for (const previous of barriers.values()) if (previous.roomId === conn.roomId) release(previous);
  const now = Date.now(), barrier = { token: randomUUID(), roomId: conn.roomId, clientId: conn.clientId, hostSocket: socket.id,
    sessionId: room.activeSessionId, purpose: data.purpose, deadline: now + 3500, expires: now + 15000,
    members: new Map(Object.entries(roomSockets[conn.roomId] || {}).filter(([, member]) => member.nick).map(([id, member]) => [id, { nick: member.nick, reason: 'waiting' }])) };
  barriers.set(barrier.token, barrier);
  require('./app').io.to(conn.roomId).emit('snapshot_probe', view(barrier));
  return { ok: true, ...view(barrier) };
}
function capture(roomId, clientId, token, purpose, force = false) {
  const barrier = barriers.get(token);
  if (!barrier || !check(barrier) || barrier.roomId !== roomId || barrier.clientId !== clientId || barrier.purpose !== purpose) throw new (require('./config').HttpError)(409, 'The snapshot request expired', 'snapshot.expired');
  if (!force && [...barrier.members.values()].some(member => member.reason !== 'ready')) throw new (require('./config').HttpError)(409, 'Some players are not ready for the snapshot', 'snapshot.notReady');
  const snapshot = structuredClone(require('./rooms').getRoom(roomId));
  release(barrier); return snapshot;
}
function register(socket, conn) {
  socket.on('snapshot_request', (data = {}, ack) => { if (typeof ack === 'function') ack(start(socket, conn, data)); });
  socket.on('snapshot_ready', (data = {}, ack) => {
    const barrier = barriers.get(data.token), member = barrier?.members.get(socket.id);
    if (typeof ack !== 'function') return;
    if (!barrier || !member || !check(barrier) || data.sessionId !== barrier.sessionId || conn.roomId !== barrier.roomId || !reasons.has(data.reason)) return ack({ ok: false });
    if (member.reason !== 'ready') member.reason = data.reason;
    ack?.({ ok: true, frozen: member.reason === 'ready' });
    require('./app').io.to(barrier.hostSocket).emit('snapshot_status', view(barrier));
  });
  socket.on('snapshot_status_request', (data = {}, ack) => {
    if (typeof ack !== 'function') return;
    const barrier = barriers.get(data.token);
    ack?.(barrier && barrier.hostSocket === socket.id && check(barrier) ? { ok: true, ...view(barrier) } : { ok: false, reason: 'expired' });
  });
  socket.on('snapshot_cancel', (data = {}) => { const barrier = barriers.get(data.token); if (barrier?.hostSocket === socket.id) release(barrier); });
}
setInterval(() => { for (const barrier of barriers.values()) check(barrier); }, 250).unref();
module.exports = { register, start, capture, frozen, frozenClient, blocked, view,
  isBusy: () => [...barriers.values()].some(barrier => check(barrier)) };
