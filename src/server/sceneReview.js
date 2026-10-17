const fs = require('node:fs');
function canListen(room, line, nick) {
  const author = line.recordedBy || require('./auth').getLineOwner(room, line);
  return !!line.audioUrl && (room.singlePlayer || !author || author === nick || line.blindRevealed || !room.blindMode && !(room.blindPlayers || []).includes(author));
}
function status(url) {
  try { const file = require('./files').diskPathForUrl(url), stat = file && fs.lstatSync(file); return stat?.isFile() && !stat.isSymbolicLink() && stat.size > 0 ? 'ready' : 'missing'; }
  catch (error) { return error.code === 'ENOENT' ? 'missing' : 'temporary'; }
}
function pruneChecks(scene) {
  if (!scene?.takeChecks || !Object.keys(scene.takeChecks).length) return;
  const ids = new Set([...(scene.lines || []), ...(scene.deletedLines || []).flatMap(batch => (batch.lines || []).map(entry => entry.line))].filter(Boolean).flatMap(line => [line.takeId, ...(line.takeHistory || []).map(take => take.id)]));
  scene.takeChecks = Object.assign(Object.create(null), Object.fromEntries(Object.entries(scene.takeChecks).filter(([id, result]) => ids.has(id) && result && require('../public/speech-model').validQuality(result))));
}
function register() {
  const { app } = require('./app'), desktop = require('./desktop');
  app.get('/api/scene-review', desktop.mediaAccessGate, (req, res) => {
    const id = desktop.resolveRoomId(req.query.room), { rooms, roomSockets, recordingNow } = require('./state'), room = rooms[id], identity = desktop.clientIdFromCookie(req.headers.cookie);
    const member = Object.values(roomSockets[id] || {}).find(member => member.clientId === identity && member.nick);
    if (!room || !member || identity !== req.query.clientId || room.banned?.includes(identity)) return res.status(403).json({ key: 'exportVideo.authorization' });
    if (!room.loaded || req.query.sessionId !== room.activeSessionId) return res.status(409).json({ key: 'render.sceneChanged' });
    const audio = require('../public/project-audio'), sources = audio.sources(room), gains = audio.gains(audio.normalize(room), sources);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ sessionId: room.activeSessionId, pending: Object.keys(recordingNow[id] || {}).length,
      takes: room.lines.filter(line => canListen(room, line, member.nick)).map(line => ({ lineId: line.id, takeId: line.takeId, status: status(line.audioUrl), quality: Object.hasOwn(room.takeChecks || {}, line.takeId) ? room.takeChecks[line.takeId] : null })),
      sources: ['video', 'original', 'backing'].filter(channel => channel === 'video' || sources[channel] && gains[channel] > 0).map(channel => ({ channel, status: status(channel === 'video' ? room.videoUrl : sources[channel]) })) });
  });
}
module.exports = { canListen, status, pruneChecks, register };
