const model = require('../public/voice-preset-model');
const fail = key => { throw Error('preset.' + key); };
function plan(room, conn, data, moderator) {
  if (!data || !['create', 'rename', 'update', 'delete'].includes(data.action) || !require('../public/voice-chain-model').id(data.id) || !Number.isSafeInteger(data.revision) || data.revision < 0) fail('invalid');
  const next = Object.assign(Object.create(null), structuredClone(room.voicePresets || {})), previous = Object.hasOwn(next, data.id) ? next[data.id] : null;
  if (data.action === 'create') {
    if (previous || data.revision !== 0) fail('conflict');
    if (Object.keys(next).length >= model.MAX_PRESETS) fail('capacity');
    if (!model.name(data.name) || !model.validSettings(data.settings)) fail('invalid');
    next[data.id] = { id: data.id, name: data.name.trim(), ...structuredClone(data.settings), createdBy: conn.nick, revision: 1 };
  } else {
    if (!previous) fail('missing');
    if (!moderator && previous.createdBy !== conn.nick) fail('owner');
    if (data.revision !== previous.revision || previous.revision >= Number.MAX_SAFE_INTEGER) fail('conflict');
    if (data.action === 'delete') delete next[data.id];
    else {
      if (data.action === 'rename' && !model.name(data.name) || data.action === 'update' && !model.validSettings(data.settings)) fail('invalid');
      next[data.id] = data.action === 'rename' ? { ...previous, name: data.name.trim(), revision: previous.revision + 1 } :
        { id: previous.id, name: previous.name, ...structuredClone(data.settings), createdBy: previous.createdBy, revision: previous.revision + 1 };
    }
  }
  if (!model.validLibrary(next)) fail('invalid');
  return next;
}
function register(socket, conn) {
  require('./editorOperations').registerMutation(socket, conn, 'voice_preset_update', (data, ack) => {
    try {
      const rooms = require('./rooms'), room = rooms.getRoom(conn.roomId), auth = require('./auth');
      if (!conn.nick || !auth.isAuthorized(room, conn.nick, conn.clientId)) fail('owner');
      if (!room.loaded || !room.activeSessionId) fail('missing');
      const next = plan(room, conn, data, auth.canModerate(room, conn.clientId));
      const previous = room.voicePresets, previousAt = room.updatedAt;
      room.voicePresets = next; room.updatedAt = Date.now();
      try { rooms.flushRooms({ strict: true }); }
      catch { room.voicePresets = previous; room.updatedAt = previousAt; rooms.snapshotActive(room); fail('storage'); }
      require('./app').io.to(conn.roomId).emit('voice_presets_updated', { sessionId: room.activeSessionId, voicePresets: next, editorProtocol: require('./editorOperations').snapshotProtocol(room) });
      ack({ ok: true, voicePresets: next });
    } catch (error) { ack({ ok: false, reason: error.message.startsWith('preset.') ? error.message : 'preset.invalid' }); }
  });
}
module.exports = { model, plan, register };
