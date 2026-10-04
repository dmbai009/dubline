const { io } = require('../app');
const { getRoom, saveRooms, snapshotActive } = require('../rooms');
const { isHost } = require('../auth');
const model = require('../../public/project-audio');
module.exports = function(socket, conn) {
  socket.on('project_audio_update', (data = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) return reply({ ok: false, reason: 'invalid' });
    if (!conn.roomId || !conn.nick) return reply({ ok: false, reason: 'room' });
    const room = getRoom(conn.roomId);
    if (!room.loaded || data.sessionId !== room.activeSessionId) return reply({ ok: false, reason: 'session' });
    if (!isHost(room, conn.clientId) && room.mode !== 'edit') return reply({ ok: false, reason: 'host' });
    const current = model.normalize(room);
    if (data.revision !== current.revision) return reply({ ok: false, reason: 'conflict', mix: current, sessionId: room.activeSessionId });
    const channel = data.channel;
    const field = data.field;
    const numeric = field === 'volume' || field === 'offset' || field === 'autoDuckAmount';
    const allowed = model.CHANNELS.includes(channel)
      ? ['volume', 'muted', 'solo', ...(channel !== 'dub' ? ['offset'] : [])].includes(field)
      : channel === 'settings' && ['autoDuckEnabled', 'autoDuckAmount'].includes(field);
    if (!allowed || (numeric ? typeof data.value !== 'number' || !Number.isFinite(data.value) : typeof data.value !== 'boolean')) return reply({ ok: false, reason: 'invalid' });
    if (numeric && (field === 'offset' ? Math.abs(data.value) > 43200 : data.value < 0 || data.value > (field === 'autoDuckAmount' ? 0.8 : model.MAX_VOLUME))) return reply({ ok: false, reason: 'invalid' });
    if (channel === 'settings') current[field] = data.value;
    else current[channel][field] = data.value;
    room.projectAudio = model.normalize({ ...room, projectAudio: current });
    room.projectAudio.revision++;
    room.updatedAt = Date.now();
    snapshotActive(room);
    saveRooms();
    const result = { ok: true, sessionId: room.activeSessionId, mix: room.projectAudio };
    io.to(conn.roomId).emit('project_audio_updated', result);
    reply(result);
  });
};
