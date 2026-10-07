// A line/role ID is meaningful only inside its captured scene. This boundary
// rejects unscoped legacy mutations before any handler can touch active state.
const SCENE_MUTATIONS = new Set([
  'claim_character', 'unclaim_character', 'claim_line', 'unclaim_line',
  'host_release_lines', 'host_reset_claims', 'recording_status',
  'set_take_props', 'set_takes_props', 'set_line_character', 'set_lines_character',
  'rename_character', 'set_session_mode', 'editor_create_line', 'editor_update_line',
  'editor_update_lines', 'editor_delete_lines', 'editor_add_track', 'editor_undo',
  'host_delete_lines', 'host_undo_delete', 'host_trash_restore', 'host_trash_purge',
  'host_set_audio_tracks', 'random_cast', 'host_reveal_takes', 'set_blind_mode', 'set_blind_preference',
  'host_watch_start', 'host_watch_sync', 'host_watch_stop', 'host_force_pause',
  'set_needs_retake', 'project_audio_update', 'p2p_have', 'p2p_find', 'p2p_signal'
]);

function register(socket, conn) {
  socket.use(([event, data, ack], next) => {
    if (!SCENE_MUTATIONS.has(event)) return next();
    const member = require('./state').roomSockets[conn.roomId]?.[socket.id];
    const room = conn.roomId && require('./rooms').getRoom(conn.roomId);
    const reason = !member?.nick || member.clientId !== conn.clientId ? 'room'
      : !data || data.sessionId !== room.activeSessionId ? 'session' : null;
    if (reason) {
      if (typeof ack === 'function') ack({ ok: false, reason, sessionId: room?.activeSessionId });
      return;
    }
    const observational = ['p2p_have', 'p2p_find', 'p2p_signal', 'host_watch_sync', 'host_watch_stop', 'recording_status'].includes(event);
    if (!observational && !data?.operationId && require('./snapshotBarrier').frozen(conn.roomId, socket.id)) {
      if (typeof ack === 'function') ack({ ok: false, reason: 'snapshot' });
      return;
    }
    next();
  });
}

function emitLines(roomId, lines, bulk = false) {
  const room = require('./rooms').getRoom(roomId);
  const payload = { sessionId: room.activeSessionId,
    editorProtocol: require('./editorOperations').snapshotProtocol(room) };
  if (bulk) payload.lines = lines;
  else payload.line = lines[0];
  require('./app').io.to(roomId).emit(bulk ? 'takes_updated' : 'line_updated', payload);
}

module.exports = { SCENE_MUTATIONS, register, emitLines };
