// Line deletion by the host, undo (Ctrl+Z) and the trash
const { MAX_UNDO_BATCHES } = require('../config');
const { logEvent } = require('../log');
const { deleteTakeFile } = require('../files');
const { saveRooms, getRoom, snapshotActive, insertLineInOrder, emitSession, dropEmptyRoleClaims } = require('../rooms');
const { isHost } = require('../auth');

module.exports = function registerTrashHandlers(socket, conn) {
  // The host deletes selected lines (e.g. on-screen signs that should not be dubbed)
  socket.on('host_delete_lines', ({ lineIds } = {}) => {
    if (!conn.roomId || !Array.isArray(lineIds)) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId) || room.mode !== 'edit') return;
    const doomed = new Set(lineIds);
    // Remember where the lines were so undo puts them back
    const removed = room.lines.map((line, index) => ({ line, index })).filter(entry => doomed.has(entry.line.id));
    if (!removed.length) return;
    room.lines.splice(0, room.lines.length, ...room.lines.filter(line => !doomed.has(line.id)));
    const claimsBefore = { ...room.characterClaims };
    dropEmptyRoleClaims(room);
    const droppedClaims = Object.fromEntries(Object.entries(claimsBefore).filter(([character]) => !room.characterClaims[character]));

    // Deletions go to the session trash; takes are erased from disk only when undo is no longer possible
    if (!Array.isArray(room.deletedLines)) room.deletedLines = [];
    room.deletedLines.push({ at: Date.now(), by: conn.nick, lines: removed, claims: droppedClaims });
    while (room.deletedLines.length > MAX_UNDO_BATCHES) {
      room.deletedLines.shift().lines.forEach(entry => deleteTakeFile(entry.line.audioUrl));
    }
    snapshotActive(room);
    saveRooms();
    emitSession(conn.roomId);
    socket.emit('lines_deleted', { count: removed.length });
    logEvent(conn.roomId, `🗑 ${conn.nick} deleted lines: ${removed.length}`);
  });

  // Undo the last line deletion (the host's Ctrl+Z)
  socket.on('host_undo_delete', () => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId) || room.mode !== 'edit' || !Array.isArray(room.deletedLines) || !room.deletedLines.length) return;
    const batch = room.deletedLines.pop();
    const existing = new Set(room.lines.map(line => line.id));
    const restored = batch.lines.filter(entry => !existing.has(entry.line.id)).sort((a, b) => a.index - b.index);
    restored.forEach(entry => insertLineInOrder(room.lines, entry.line));
    // Roles released together with a character's last lines come back if nobody has claimed them
    for (const [character, owner] of Object.entries(batch.claims || {})) {
      if (!room.characterClaims[character]) room.characterClaims[character] = owner;
    }
    snapshotActive(room);
    saveRooms();
    emitSession(conn.roomId);
    socket.emit('lines_restored', { count: restored.length });
    logEvent(conn.roomId, `↶ ${conn.nick} restored deleted lines: ${restored.length}`);
  });

  // ---------- Trash of deleted lines (host only) ----------
  function trashEntries(room) {
    const list = [];
    (room.deletedLines || []).forEach(batch => batch.lines.forEach(entry => list.push({
      lineId: entry.line.id,
      revision: entry.line.revision || 0,
      audioUrl: entry.line.audioUrl || null,
      character: entry.line.character,
      caption: String(entry.line.caption || '').slice(0, 300),
      start: entry.line.start,
      hasTake: !!entry.line.audioUrl,
      by: batch.by,
      at: batch.at
    })));
    return list.sort((a, b) => b.at - a.at || a.start - b.start);
  }

  // Take trash entries by line id; drop emptied deletions from the stack
  function takeFromTrash(room, lineIds) {
    const wanted = new Set(lineIds);
    const taken = [];
    for (const batch of room.deletedLines || []) {
      const keep = [];
      for (const entry of batch.lines) {
        if (wanted.has(entry.line.id)) taken.push({ entry, claims: batch.claims || {} });
        else keep.push(entry);
      }
      batch.lines = keep;
    }
    room.deletedLines = (room.deletedLines || []).filter(batch => batch.lines.length);
    return taken;
  }

  socket.on('host_trash_list', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : (typeof payload === 'function' ? payload : () => {});
    if (!conn.roomId) return reply([]);
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId)) return reply([]);
    reply(trashEntries(room));
  });

  socket.on('host_trash_restore', ({ lineIds } = {}) => {
    if (!conn.roomId || !Array.isArray(lineIds)) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId) || room.mode !== 'edit') return;
    const existing = new Set(room.lines.map(line => line.id));
    const taken = takeFromTrash(room, lineIds).filter(item => !existing.has(item.entry.line.id));
    if (!taken.length) return;
    // Put them back where they were
    taken.forEach(item => insertLineInOrder(room.lines, item.entry.line));
    taken.forEach(item => {
      const character = item.entry.line.character;
      const owner = item.claims[character];
      if (owner && !room.characterClaims[character]) room.characterClaims[character] = owner;
    });
    snapshotActive(room);
    saveRooms();
    emitSession(conn.roomId);
    socket.emit('lines_restored', { count: taken.length });
    logEvent(conn.roomId, `↶ ${conn.nick} restored lines from the trash: ${taken.length}`);
  });

  // Permanent deletion from the trash: only then are take files erased
  socket.on('host_trash_purge', ({ lineIds, sessionId, entries } = {}) => {
    if (!conn.roomId || !Array.isArray(lineIds)) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId) || room.mode !== 'edit') return;
    if (sessionId !== undefined && sessionId !== room.activeSessionId) return;
    if (entries !== undefined) {
      const current = trashEntries(room);
      if (!Array.isArray(entries) || entries.length !== lineIds.length || entries.some(expected => !current.some(item => item.lineId === expected.lineId && item.at === expected.at && item.revision === expected.revision && item.audioUrl === expected.audioUrl))) return;
    }
    const taken = takeFromTrash(room, lineIds);
    if (!taken.length) return;
    taken.forEach(item => deleteTakeFile(item.entry.line.audioUrl));
    snapshotActive(room);
    saveRooms();
    emitSession(conn.roomId);
    logEvent(conn.roomId, `🗑 ${conn.nick} permanently deleted lines from the trash: ${taken.length}`);
  });
};
