const { randomUUID } = require('node:crypto');
const { rooms, roomSockets } = require('./state');
const { isHost, isAuthorized } = require('./auth');

function publicRecords(room) {
  const roomId = Object.keys(rooms).find(id => rooms[id] === room);
  const members = Object.values(roomSockets[roomId] || {});
  return (room.moderators || []).map(entry => {
    const member = members.find(item => item.clientId === entry.clientId && isAuthorized(room, item.nick, item.clientId));
    return { id: entry.id, nick: member?.nick || entry.nick, online: !!member };
  });
}
function revokeClient(room, clientId) { room.moderators = (room.moderators || []).filter(entry => entry.clientId !== clientId); }
function register(socket, conn) {
  for (const granting of [true, false]) socket.on(granting ? 'host_grant_moderator' : 'host_revoke_moderator', (data = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const member = roomSockets[conn.roomId]?.[socket.id];
    if (!member?.nick || member.clientId !== conn.clientId) return reply({ ok: false, reason: 'room' });
    const { getRoom, flushRooms } = require('./rooms');
    const room = getRoom(conn.roomId);
    if (member.nick !== conn.nick || !isAuthorized(room, conn.nick, conn.clientId) || !isHost(room, conn.clientId)) return reply({ ok: false, reason: 'host' });
    if (!data || typeof data !== 'object') return reply({ ok: false, reason: 'invalid' });
    if (room.singlePlayer) return reply({ ok: false, reason: 'mode' });
    const blocked = require('./snapshotBarrier').blocked(socket, conn);
    if (blocked) return reply(blocked);
    let entry;
    if (granting) {
      const target = Object.values(roomSockets[conn.roomId] || {}).find(item => item.nick === data.nick && isAuthorized(room, item.nick, item.clientId));
      if (!target || isHost(room, target.clientId) || room.banned.includes(target.clientId)) return reply({ ok: false, reason: 'target' });
      entry = room.moderators.find(item => item.clientId === target.clientId);
      if (entry) return reply({ ok: true, changed: false });
      entry = { id: randomUUID(), clientId: target.clientId, nick: target.nick };
      room.moderators.push(entry);
    } else {
      if (typeof data.id !== 'string' || !data.id) return reply({ ok: false, reason: 'invalid' });
      entry = room.moderators.find(item => item.id === data.id);
      if (!entry) return reply({ ok: true, changed: false });
      revokeClient(room, entry.clientId);
    }
    // A role-only update must not replace a scene or cancel another user's edit.
    flushRooms(); require('./presence').broadcastRoomUsers(conn.roomId);
    const key = granting ? 'moderator.granted' : 'moderator.revoked';
    require('./presence').addSystemMessage(conn.roomId, key, { nick: entry.nick, by: conn.nick });
    require('./log').logEvent(conn.roomId, `${conn.nick} ${granting ? 'granted' : 'revoked'} moderator: ${entry.nick}`);
    reply({ ok: true, changed: true });
  });
}
module.exports = { publicRecords, revokeClient, register };
