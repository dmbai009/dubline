// Local renders retain only their authorized snapshot files, without freezing other actors.
const crypto = require('node:crypto');
const { app, io } = require('./app'), { rooms, roomSockets } = require('./state');
const { resolveRoomId, clientIdFromCookie, mediaAccessGate } = require('./desktop');
const leases = new Map(), TTL = 2 * 60 * 60 * 1000;
function release(ticket) {
  const lease = leases.get(ticket); if (!lease) return;
  leases.delete(ticket); clearTimeout(lease.timer); lease.socket?.removeListener('disconnect', lease.onDisconnect); lease.releaseFiles();
}
function arm(ticket, lease) { clearTimeout(lease.timer); lease.timer = setTimeout(() => release(ticket), TTL); lease.timer.unref(); }
app.post('/api/video-export-lease', (req, res, next) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ key: 'error.badRequest' });
  return req.body.release === true ? next() : mediaAccessGate(req, res, next);
}, (req, res) => {
  const roomId = resolveRoomId(req.body.room), room = rooms[roomId], identity = clientIdFromCookie(req.headers.cookie);
  if (req.body.release === true) {
    const lease = leases.get(req.body.ticket);
    if (!identity || identity !== req.body.clientId || !lease || lease.roomId !== roomId || lease.identity !== identity) return res.status(403).json({ key: 'exportVideo.authorization' });
    release(req.body.ticket); return res.json({ ok: true });
  }
  const member = Object.entries(roomSockets[roomId] || {}).find(([, value]) => value.clientId === identity && value.nick);
  if (!identity || identity !== req.body.clientId || !room || !member || room.banned?.includes(identity)) return res.status(403).json({ key: 'exportVideo.authorization' });
  if (req.body.ticket) {
    const lease = leases.get(req.body.ticket);
    if (!lease || lease.roomId !== roomId || lease.identity !== identity) return res.status(403).json({ key: 'exportVideo.authorization' });
    if (req.body.release) { release(req.body.ticket); return res.json({ ok: true }); }
    if (lease.sessionId !== room.activeSessionId || lease.videoUrl !== room.videoUrl) { release(req.body.ticket); return res.status(409).json({ key: 'render.sceneChanged' }); }
    arm(req.body.ticket, lease); return res.json({ ok: true });
  }
  if (!room.loaded || req.body.sessionId !== room.activeSessionId || req.body.videoUrl !== room.videoUrl) return res.status(409).json({ key: 'render.sceneChanged' });
  if (leases.size >= 32 || [...leases.values()].filter(lease => lease.identity === identity).length >= 2) return res.status(429).json({ key: 'project.busy' });
  const scene = require('./rooms').publicRoom(room), nick = member[1].nick;
  const takes = scene.lines.filter(line => {
    if (!line.audioUrl) return false;
    const author = line.recordedBy || require('./auth').getLineOwner(room, line);
    return room.singlePlayer || !author || author === nick || line.blindRevealed || !room.blindMode && !(room.blindPlayers || []).includes(author);
  });
  const sources = require('../public/project-audio').sources(scene);
  const ticket = crypto.randomUUID(), socket = io.sockets.sockets.get(member[0]);
  const lease = { roomId, identity, sessionId: room.activeSessionId, videoUrl: room.videoUrl, socket, releaseFiles: require('./files').retainTakeFiles([scene.videoUrl, sources.original, sources.backing, ...takes.map(line => line.audioUrl)]), onDisconnect: () => release(ticket) };
  leases.set(ticket, lease); socket?.once('disconnect', lease.onDisconnect); arm(ticket, lease);
  res.setHeader('Cache-Control', 'no-store'); res.json({ ticket, scene, takeIds: takes.map(line => line.id) });
});
module.exports = { release, close: () => { for (const ticket of leases.keys()) release(ticket); } };
