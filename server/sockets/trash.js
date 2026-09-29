// Удаление реплик хостом, отмена (Ctrl+Z) и корзина
const { MAX_UNDO_BATCHES } = require('../config');
const { logEvent } = require('../log');
const { deleteTakeFile } = require('../files');
const { saveRooms, getRoom, snapshotActive, insertLineInOrder, emitSession, dropEmptyRoleClaims } = require('../rooms');
const { isHost } = require('../auth');

module.exports = function registerTrashHandlers(socket, conn) {
  // Хост удаляет выбранные реплики (например, надписи на экране, которые не нужно озвучивать)
  socket.on('host_delete_lines', ({ lineIds } = {}) => {
    if (!conn.roomId || !Array.isArray(lineIds)) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId)) return;
    const doomed = new Set(lineIds);
    // Запоминаем, где стояли реплики, чтобы отмена вернула их на место
    const removed = room.lines.map((line, index) => ({ line, index })).filter(entry => doomed.has(entry.line.id));
    if (!removed.length) return;
    room.lines.splice(0, room.lines.length, ...room.lines.filter(line => !doomed.has(line.id)));
    const claimsBefore = { ...room.characterClaims };
    dropEmptyRoleClaims(room);
    const droppedClaims = Object.fromEntries(Object.entries(claimsBefore).filter(([character]) => !room.characterClaims[character]));

    // Удаление уходит в «корзину» сессии; дубли стираются с диска, только когда отменить уже нельзя
    if (!Array.isArray(room.deletedLines)) room.deletedLines = [];
    room.deletedLines.push({ at: Date.now(), by: conn.nick, lines: removed, claims: droppedClaims });
    while (room.deletedLines.length > MAX_UNDO_BATCHES) {
      room.deletedLines.shift().lines.forEach(entry => deleteTakeFile(entry.line.audioUrl));
    }
    snapshotActive(room);
    saveRooms();
    emitSession(conn.roomId);
    socket.emit('lines_deleted', { count: removed.length });
    logEvent(conn.roomId, `🗑 ${conn.nick} удалил реплик: ${removed.length}`);
  });

  // Отмена последнего удаления реплик (Ctrl+Z у хоста)
  socket.on('host_undo_delete', () => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId) || !Array.isArray(room.deletedLines) || !room.deletedLines.length) return;
    const batch = room.deletedLines.pop();
    const existing = new Set(room.lines.map(line => line.id));
    const restored = batch.lines.filter(entry => !existing.has(entry.line.id)).sort((a, b) => a.index - b.index);
    restored.forEach(entry => insertLineInOrder(room.lines, entry.line));
    // Роли, снятые вместе с последними репликами персонажа, возвращаем, если их никто не занял
    for (const [character, owner] of Object.entries(batch.claims || {})) {
      if (!room.characterClaims[character]) room.characterClaims[character] = owner;
    }
    snapshotActive(room);
    saveRooms();
    emitSession(conn.roomId);
    socket.emit('lines_restored', { count: restored.length });
    logEvent(conn.roomId, `↶ ${conn.nick} вернул удаленные реплики: ${restored.length}`);
  });

  // ---------- Корзина удаленных реплик (только хост) ----------
  function trashEntries(room) {
    const list = [];
    (room.deletedLines || []).forEach(batch => batch.lines.forEach(entry => list.push({
      lineId: entry.line.id,
      character: entry.line.character,
      caption: String(entry.line.caption || '').slice(0, 300),
      start: entry.line.start,
      hasTake: !!entry.line.audioUrl,
      by: batch.by,
      at: batch.at
    })));
    return list.sort((a, b) => b.at - a.at || a.start - b.start);
  }

  // Достаем записи корзины по номерам реплик; пустые удаления убираем из стека
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
    if (!isHost(room, conn.clientId)) return;
    const existing = new Set(room.lines.map(line => line.id));
    const taken = takeFromTrash(room, lineIds).filter(item => !existing.has(item.entry.line.id));
    if (!taken.length) return;
    // Возвращаем на прежние места
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
    logEvent(conn.roomId, `↶ ${conn.nick} вернул из корзины реплик: ${taken.length}`);
  });

  // Окончательное удаление из корзины: только тогда стираются файлы дублей
  socket.on('host_trash_purge', ({ lineIds } = {}) => {
    if (!conn.roomId || !Array.isArray(lineIds)) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId)) return;
    const taken = takeFromTrash(room, lineIds);
    if (!taken.length) return;
    taken.forEach(item => deleteTakeFile(item.entry.line.audioUrl));
    snapshotActive(room);
    saveRooms();
    emitSession(conn.roomId);
    logEvent(conn.roomId, `🗑 ${conn.nick} удалил из корзины навсегда реплик: ${taken.length}`);
  });
};
