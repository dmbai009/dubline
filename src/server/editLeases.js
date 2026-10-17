// Advisory display and authoritative exclusion share the same ephemeral leases.
// Selection is independent; different semantic groups may edit the same line.
const { randomUUID } = require('node:crypto');
const { roomSockets } = require('./state');
const rooms = new Map();
const TTL_MS = 8000, MAX_TARGETS = 128;
const groups = new Set(['caption', 'timing', 'assignment', 'structural']);
function conflict(a, b, room) {
  if (a.type === 'session' || b.type === 'session') return a.group === 'structural' || b.group === 'structural';
  const lineTrack = target => target.type === 'track' ? target.key : room.lines.find(line => line.id === target.key)?.character;
  if (a.type === 'track' || b.type === 'track') return lineTrack(a) === lineTrack(b) && (a.group === 'structural' || b.group === 'structural');
  return a.key === b.key && (a.group === b.group || a.group === 'structural' || b.group === 'structural');
}
function prune(roomId) {
  const room = require('./rooms').getRoom(roomId), records = rooms.get(roomId);
  if (!records) return;
  for (const [token, lease] of records) {
    const member = roomSockets[roomId]?.[lease.socketId];
    if (lease.expires <= Date.now() || lease.sessionId !== room.activeSessionId || room.mode !== 'edit' || !member || member.clientId !== lease.clientId) records.delete(token);
    else lease.nick = member.nick;
  }
  if (!records.size) rooms.delete(roomId);
}
function snapshot(roomId) {
  prune(roomId);
  return { sessionId: require('./rooms').getRoom(roomId).activeSessionId,
    leases: [...(rooms.get(roomId)?.values() || [])].map(({ token, socketId, nick, targets, expires }) => ({ token, actorId: socketId, nick, targets, expires })) };
}
function broadcast(roomId) { require('./app').io.to(roomId).emit('edit_leases', snapshot(roomId)); }
function blocked(roomId, socketId, targets) {
  prune(roomId);
  const room = require('./rooms').getRoom(roomId);
  return [...(rooms.get(roomId)?.values() || [])].find(lease => lease.socketId !== socketId && targets.some(target => lease.targets.some(other => conflict(target, other, room))));
}
function mutationTargets(event, data) {
  const line = (id, group) => ({ type: 'line', key: id, group });
  if (['editor_update_line', 'editor_update_lines'].includes(event)) {
    return (event === 'editor_update_line' ? [data] : Array.isArray(data.updates) ? data.updates : []).filter(patch => patch && typeof patch === 'object').flatMap(patch => [
      ...(patch.caption !== undefined ? [line(patch.lineId, 'caption')] : []),
      ...(patch.start !== undefined || patch.end !== undefined ? [line(patch.lineId, 'timing')] : []),
      ...(patch.character !== undefined ? [line(patch.lineId, 'assignment')] : [])]);
  }
  if (event === 'set_line_character') return [line(data.lineId, 'assignment')];
  if (event === 'set_lines_character') return (Array.isArray(data.lines) ? data.lines : []).filter(Boolean).map(item => line(item.lineId, 'assignment'));
  if (event === 'editor_delete_lines') return (Array.isArray(data.lines) ? data.lines : []).filter(Boolean).map(item => line(item.lineId, 'structural'));
  if (event === 'rename_character') return [{ type: 'track', key: data.from, group: 'structural' }, { type: 'track', key: data.to, group: 'structural' }];
  if (event === 'editor_create_line' || event === 'editor_add_track') return [{ type: 'track', key: data.character, group: 'structural' }];
  if (event === 'editor_undo') return [{ type: 'session', key: '*', group: 'structural' }];
  if (event === 'editor_reorder_track' || event === 'editor_delete_track') return [{ type: 'session', key: '*', group: 'structural' }];
  return [];
}
function checkMutation(socket, conn, event, data) {
  const lease = blocked(conn.roomId, socket.id, mutationTargets(event, data));
  return lease ? { ok: false, reason: 'locked', by: lease.nick, targets: lease.targets } : null;
}
function clear(socketId, roomId) {
  const records = rooms.get(roomId);
  if (!records) return;
  let changed = false;
  for (const [token, lease] of records) if (lease.socketId === socketId) { records.delete(token); changed = true; }
  if (changed) broadcast(roomId);
}
function register(socket, conn) {
  const validMember = data => conn.roomId && roomSockets[conn.roomId]?.[socket.id]?.nick &&
    data?.sessionId === require('./rooms').getRoom(conn.roomId).activeSessionId && require('./rooms').getRoom(conn.roomId).mode === 'edit';
  socket.on('edit_lease_acquire', (data = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (!validMember(data)) return ack({ ok: false, reason: 'session' });
    const room = require('./rooms').getRoom(conn.roomId), targets = data.targets;
    if (data.acquisitionId !== undefined && (typeof data.acquisitionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(data.acquisitionId))) return ack({ ok: false, reason: 'invalid' });
    if (!Array.isArray(targets) || !targets.length || targets.length > MAX_TARGETS || targets.some(target =>
      !groups.has(target.group) || (target.type === 'line' ? !Number.isSafeInteger(target.key) || !room.lines.some(line => line.id === target.key)
        : target.type === 'track' ? typeof target.key !== 'string' || !room.trackOrder.includes(target.key)
          : target.type !== 'session' || target.key !== '*' || target.group !== 'structural'))) return ack({ ok: false, reason: 'invalid' });
    const foreign = blocked(conn.roomId, socket.id, targets);
    if (foreign) return ack({ ok: false, reason: 'locked', by: foreign.nick });
    if (!rooms.has(conn.roomId)) rooms.set(conn.roomId, new Map());
    const records = rooms.get(conn.roomId);
    if ([...records.values()].filter(lease => lease.socketId === socket.id).length >= 8 || records.size >= 512) return ack({ ok: false, reason: 'capacity' });
    const lease = { token: randomUUID(), socketId: socket.id, clientId: conn.clientId, nick: conn.nick,
      sessionId: room.activeSessionId, acquisitionId: data.acquisitionId, targets: structuredClone(targets), expires: Date.now() + TTL_MS };
    records.set(lease.token, lease); ack({ ok: true, token: lease.token, expires: lease.expires }); broadcast(conn.roomId);
  });
  socket.on('edit_lease_heartbeat', (data = {}) => {
    if (!validMember(data)) return;
    const lease = rooms.get(conn.roomId)?.get(data.token);
    if (lease?.socketId === socket.id) lease.expires = Date.now() + TTL_MS;
  });
  socket.on('edit_lease_release', (data = {}) => {
    const records = rooms.get(conn.roomId), lease = records?.get(data.token);
    if (lease?.socketId === socket.id) { records.delete(data.token); broadcast(conn.roomId); }
  });
  socket.on('edit_lease_cancel', (data = {}) => {
    if (typeof data.acquisitionId !== 'string' || data.acquisitionId.length !== 36) return;
    const records = rooms.get(conn.roomId);
    if (!records) return;
    let changed = false;
    for (const [token, lease] of records) if (lease.socketId === socket.id && lease.acquisitionId === data.acquisitionId) { records.delete(token); changed = true; }
    if (changed) broadcast(conn.roomId);
  });
}
setInterval(() => {
  for (const roomId of [...rooms.keys()]) {
    const before = rooms.get(roomId).size; prune(roomId);
    if (before !== (rooms.get(roomId)?.size || 0)) broadcast(roomId);
  }
}, 1000).unref();
module.exports = { register, clear, snapshot, broadcast, checkMutation, mutationTargets, conflict, TTL_MS };
