const history = require('../takeHistory');
const { registerMutation } = require('../editorOperations');
module.exports = function registerTakeHistory(socket, conn) {
  registerMutation(socket, conn, 'take_history_update', (data, ack) => {
    try {
      if (typeof data.room !== 'string' || require('../desktop').resolveRoomId(data.room) !== conn.roomId) throw history.failure('changed');
      const room = require('../rooms').getRoom(conn.roomId), line = room.lines.find(line => line.id === data.lineId);
      if (!line || !['dub', 'edit'].includes(room.mode)) throw history.failure('changed');
      const result = history.action(room, line, data, conn.nick, conn.clientId);
      if (result.changed) {
        history.commit(room, room, line, result.next);
        require('../sessionScope').emitLines(conn.roomId, [line]);
      }
      const cleanupError = history.cleanup(result.deleted, conn.roomId, room.activeSessionId, line.id);
      ack({ ok: true, changed: result.changed, line, cleanupError });
    } catch (error) { ack({ ok: false, reason: error.key || 'takeHistory.storage' }); }
  });
};
