const model = require('../public/noise-model');
const empty = model.empty;
const state = scene => model.validState(scene?.noiseReduction) ? scene.noiseReduction : empty();
const required = scene => Object.values(state(scene).actors).some(a => a.enabled && a.strength > 0);
function plan(scene, nick, data) {
  const previous = state(scene);
  const fields = [...Object.keys(model.protocol()), 'actor', 'revision', 'sessionId', 'operationId', 'operationEpoch', 'operationTime'];
  if (!data || Object.keys(data).some(key => !fields.includes(key)) || !model.compatible(data) || !model.author(nick) || !model.validActor(data.actor) ||
      !Number.isSafeInteger(data.revision) || data.revision < 0 || !Number.isSafeInteger(previous.revision) || previous.revision >= Number.MAX_SAFE_INTEGER) throw Error('noise.invalid');
  if (data.revision !== previous.revision) throw Error('noise.conflict');
  if (Object.hasOwn(previous.actors, nick) && previous.actors[nick].enabled === data.actor.enabled && previous.actors[nick].strength === data.actor.strength) return { state: previous, changed: false };
  const next = { ...model.protocol(), actors: Object.assign(Object.create(null), structuredClone(previous.actors)), revision: previous.revision + 1 };
  next.actors[nick] = { enabled: data.actor.enabled, strength: data.actor.strength };
  if (!model.validState(next)) throw Error('noise.invalid');
  return { state: next, changed: true };
}
function incompatible(roomId) {
  return Object.entries(require('./state').roomSockets[roomId] || {}).filter(([, member]) => member.noiseVersion !== model.PROCESSING_VERSION).map(([socketId]) => socketId);
}
function enforce(roomId, room) {
  if (!required(room)) return;
  const io = require('./app').io;
  for (const id of incompatible(roomId)) {
    const socket = io.sockets.sockets.get(id);
    socket?.emit('join_denied', { reason: 'noiseVersion' }); socket?.disconnect(true);
  }
}
function register(socket, conn) {
  require('./editorOperations').registerMutation(socket, conn, 'noise_update', (data, ack) => {
    try {
      const room = require('./rooms').getRoom(conn.roomId), previous = state(room);
      const result = plan(room, conn.nick, data);
      if (data.actor.enabled && data.actor.strength > 0 && incompatible(conn.roomId).length) throw Error('noise.clientUpdate');
      if (!result.changed) return ack({ ok: true, noiseReduction: previous });
      const updatedAt = room.updatedAt;
      room.noiseReduction = result.state; room.updatedAt = Date.now();
      try { require('./rooms').flushRooms({ strict: true }); }
      catch { room.noiseReduction = previous; room.updatedAt = updatedAt; require('./rooms').snapshotActive(room); throw Error('noise.storage'); }
      require('./app').io.to(conn.roomId).emit('noise_updated', { sessionId: room.activeSessionId, noiseReduction: result.state,
        author: conn.nick, editorProtocol: require('./editorOperations').snapshotProtocol(room) });
      ack({ ok: true, noiseReduction: result.state });
    } catch (error) { ack({ ok: false, reason: error.message.startsWith('noise.') ? error.message : 'noise.invalid' }); }
  });
}
function rename(scene, before, after) {
  const data = state(scene);
  if (Object.hasOwn(data.actors, before)) {
    data.actors[after] = data.actors[before]; delete data.actors[before]; data.revision++;
  }
}
module.exports = { empty, state, plan, register, rename, required, enforce };
