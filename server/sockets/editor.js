// Collaborative scene editor. Editing is deliberately unavailable in dub mode.
const { MAX_UNDO_BATCHES } = require('../config');
const { recordingNow } = require('../state');
const { io } = require('../app');
const { sanitizeChatText } = require('../sanitize');
const { emptyTake, parseSeconds } = require('../parsers');
const { deleteTakeFile } = require('../files');
const { logEvent } = require('../log');
const { getRoom, saveRooms, snapshotActive, emitSession, dropEmptyRoleClaims, normalizeEditorState, insertLineInOrder, publicRoom } = require('../rooms');
const { isHost } = require('../auth');
const { endWatch, broadcastRecording, addSystemMessage } = require('../presence');
const history = require('../editHistory');

const MAX_SCENE_SECONDS = 12 * 60 * 60;
const MIN_LINE_SECONDS = 0.1;

function cleanTrackName(raw) {
  return sanitizeChatText(raw).slice(0, 40);
}

function cleanCaption(raw) {
  return sanitizeChatText(raw).slice(0, 2000);
}

function editorAllowed(conn, room) {
  return !!conn.roomId && !!conn.nick && room.loaded && room.mode === 'edit';
}

function validBounds(startRaw, endRaw) {
  const start = parseSeconds(startRaw);
  const end = parseSeconds(endRaw);
  if (start === null || end === null || start < 0 || end > MAX_SCENE_SECONDS || end - start < MIN_LINE_SECONDS) return null;
  return { start, end };
}

function putInTrash(room, lines, by) {
  const removed = room.lines.map((line, index) => ({ line, index })).filter(entry => lines.has(entry.line.id));
  if (!removed.length) return 0;
  room.lines.splice(0, room.lines.length, ...room.lines.filter(line => !lines.has(line.id)));
  const claimsBefore = { ...room.characterClaims };
  dropEmptyRoleClaims(room);
  const droppedClaims = Object.fromEntries(Object.entries(claimsBefore).filter(([character]) => !room.characterClaims[character]));
  room.deletedLines.push({ at: Date.now(), by, lines: removed, claims: droppedClaims });
  while (room.deletedLines.length > MAX_UNDO_BATCHES) {
    room.deletedLines.shift().lines.forEach(entry => deleteTakeFile(entry.line.audioUrl));
  }
  return removed.length;
}

// Put back a deletion batch that is still in the trash (lines whose id is in use again are skipped)
function restoreBatch(room, batch) {
  room.deletedLines = room.deletedLines.filter(item => item !== batch);
  const existing = new Set(room.lines.map(line => line.id));
  const restored = batch.lines.filter(entry => !existing.has(entry.line.id)).sort((a, b) => a.index - b.index);
  restored.forEach(entry => insertLineInOrder(room.lines, entry.line));
  for (const [character, owner] of Object.entries(batch.claims || {})) {
    if (!room.characterClaims[character]) room.characterClaims[character] = owner;
  }
  return restored.length;
}

// Undo an edit's track changes when others changed the track list too: names this edit
// removed come back next to their old neighbours, names it added go away once empty.
// Covers a plain rename (A -> B) and a merge into an existing track (A -> existing B).
function undoTrackChanges(room, tracksBefore, tracksAfter, tracksOnly) {
  let changed = 0;
  const added = tracksAfter.filter(name => !tracksBefore.includes(name));
  const removed = tracksBefore.filter(name => !tracksAfter.includes(name));
  // An empty track renamed: rename it back in place, but only if it still carries the new name
  if (tracksOnly && added.length && added.length === removed.length) {
    added.forEach((name, index) => {
      const position = room.trackOrder.indexOf(name);
      if (position === -1 || room.lines.some(l => l.character === name)) return;
      room.trackOrder.splice(position, 1, removed[index]);
      room.trackOrder = [...new Set(room.trackOrder)];
      changed++;
    });
    return changed;
  }
  for (const name of added) {
    if (!room.trackOrder.includes(name) || room.lines.some(l => l.character === name)) continue;
    room.trackOrder = room.trackOrder.filter(track => track !== name);
    changed++;
  }
  for (const name of removed) {
    // A track with lines comes back with its lines; an empty one only when the edit was about tracks alone
    if (!tracksOnly && !room.lines.some(l => l.character === name)) continue;
    // Put it right after the closest earlier neighbour that still exists, or first
    const index = tracksBefore.indexOf(name);
    const anchor = tracksBefore.slice(0, index).reverse().find(track => track !== name && room.trackOrder.includes(track));
    const rest = room.trackOrder.filter(track => track !== name);
    const position = anchor ? rest.indexOf(anchor) + 1 : 0;
    const wasPresent = room.trackOrder.includes(name);
    rest.splice(position, 0, name);
    if (!wasPresent || JSON.stringify(rest) !== JSON.stringify(room.trackOrder)) changed++;
    room.trackOrder = rest;
  }
  return changed;
}

module.exports = function registerEditorHandlers(socket, conn) {
  socket.on('set_session_mode', ({ mode } = {}) => {
    if (!conn.roomId || !['edit', 'dub'].includes(mode)) return;
    const room = getRoom(conn.roomId);
    if (!isHost(room, conn.clientId) || !room.loaded || room.mode === mode) return;
    room.mode = mode;
    room.updatedAt = Date.now();
    if (mode === 'edit') {
      delete recordingNow[conn.roomId];
      endWatch(conn.roomId, conn.nick, 'Watch-together stopped: edit mode opened');
      broadcastRecording(conn.roomId);
    }
    snapshotActive(room);
    saveRooms();
    emitSession(conn.roomId);
    logEvent(conn.roomId, `✎ ${conn.nick} switched to ${mode} mode`);
    if (mode === 'edit') addSystemMessage(conn.roomId, 'system.modeEdit', { nick: conn.nick }, `✎ ${conn.nick} opened Edit Mode: the scene can be edited, recording is paused`);
    else addSystemMessage(conn.roomId, 'system.modeDub', { nick: conn.nick }, `🎙 ${conn.nick} returned to Dub Mode: recording is open again`);
  });

  // The client lost an answer: send it the current scene (read-only, nothing is repeated)
  socket.on('editor_resync', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : (typeof payload === 'function' ? payload : null);
    if (!conn.roomId || !conn.nick) return reply && reply({ ok: false, reason: 'room' });
    const session = publicRoom(getRoom(conn.roomId));
    if (reply) reply({ ok: true, session });
    else socket.emit('session_updated', session);
  });

  socket.on('editor_add_track', ({ character, sessionId } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!conn.roomId) return reply({ ok: false, reason: 'room' });
    const room = getRoom(conn.roomId);
    // In Edit Mode anyone may add a track; while dubbing only the host can
    if (sessionId !== undefined && sessionId !== room.activeSessionId) return reply({ ok: false, reason: 'session' });
    if (!editorAllowed(conn, room) && !(conn.nick && room.loaded && isHost(room, conn.clientId))) return reply({ ok: false, reason: 'mode' });
    const name = cleanTrackName(character);
    if (!name) return reply({ ok: false, reason: 'name' });
    normalizeEditorState(room);
    if (room.trackOrder.includes(name)) return reply({ ok: false, reason: 'exists', character: name });
    room.trackOrder.push(name);
    history.record(conn.roomId, room, { by: conn.clientId, type: 'track', name });
    room.updatedAt = Date.now();
    snapshotActive(room);
    saveRooms();
    emitSession(conn.roomId);
    reply({ ok: true, character: name });
  });

  socket.on('editor_create_line', (data = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!conn.roomId) return reply({ ok: false, reason: 'room' });
    const room = getRoom(conn.roomId);
    if (!editorAllowed(conn, room)) return reply({ ok: false, reason: 'mode' });
    if (data.sessionId !== undefined && data.sessionId !== room.activeSessionId) return reply({ ok: false, reason: 'session' });
    const bounds = validBounds(data.start, data.end);
    const character = cleanTrackName(data.character);
    if (!bounds || !character) return reply({ ok: false, reason: 'invalid' });
    normalizeEditorState(room);
    const line = {
      id: room.nextLineId++,
      revision: 0,
      character,
      caption: cleanCaption(data.caption),
      start: bounds.start,
      end: bounds.end,
      originalAudioUrl: null,
      claimedBy: null,
      ...emptyTake()
    };
    if (!room.trackOrder.includes(character)) room.trackOrder.push(character);
    room.lines.push(line);
    room.lines.sort((a, b) => a.start - b.start || a.id - b.id);
    history.record(conn.roomId, room, { by: conn.clientId, type: 'create', id: line.id, revAfter: 0 });
    room.updatedAt = Date.now();
    snapshotActive(room);
    saveRooms();
    emitSession(conn.roomId);
    logEvent(conn.roomId, `✎ ${conn.nick} created line #${line.id}`);
    reply({ ok: true, line });
  });

  // One line (Inspector, drag) or several dragged together. All or nothing: if any
  // line changed meanwhile, nothing is applied and the client gets the current versions.
  function updateLines(updates, reply, sessionId) {
    if (!conn.roomId) return reply({ ok: false, reason: 'room' });
    const room = getRoom(conn.roomId);
    if (!editorAllowed(conn, room)) return reply({ ok: false, reason: 'mode' });
    if (sessionId !== undefined && sessionId !== room.activeSessionId) return reply({ ok: false, reason: 'session' });
    if (!Array.isArray(updates) || !updates.length || updates.length > 2000) return reply({ ok: false, reason: 'invalid' });

    const planned = [];
    const conflicts = [];
    const ids = new Set();
    for (const data of updates) {
      const id = Number(data && data.lineId);
      if (!data || !Number.isInteger(id) || ids.has(id)) return reply({ ok: false, reason: 'invalid' });
      ids.add(id);
      const line = room.lines.find(item => item.id === id);
      if (!line) return reply({ ok: false, reason: 'missing' });
      if (Number(data.revision) !== Number(line.revision || 0)) { conflicts.push(line); continue; }
      const bounds = validBounds(data.start ?? line.start, data.end ?? line.end);
      const character = data.character === undefined ? line.character : cleanTrackName(data.character);
      if (!bounds || !character) return reply({ ok: false, reason: 'invalid' });
      planned.push({ line, bounds, character, caption: data.caption === undefined ? line.caption : cleanCaption(data.caption) });
    }
    if (conflicts.length) return reply({ ok: false, reason: 'conflict', line: conflicts[0], lines: room.lines.filter(line => ids.has(line.id)) });

    const changed = planned.filter(({ line, bounds, character, caption }) =>
      line.start !== bounds.start || line.end !== bounds.end || line.character !== character || line.caption !== caption);
    if (!changed.length) return reply({ ok: true, line: planned[0].line, lines: planned.map(item => item.line) });

    normalizeEditorState(room);
    const claimsBefore = JSON.stringify(room.characterClaims);
    const trackOrderBefore = [...room.trackOrder];
    const tracksBefore = room.trackOrder.length;
    let moved = false;
    const before = new Map(changed.map(({ line }) => [line.id, history.lineBefore(line)]));
    const claimsSnapshot = { ...room.characterClaims };
    for (const { line, bounds, character, caption } of changed) {
      const delta = bounds.start - line.start;
      // Legacy startup repair must never replace intentionally edited bounds.
      if (line.start !== bounds.start || line.end !== bounds.end) line.durationChecked = true;
      line.start = bounds.start;
      line.end = bounds.end;
      if (character !== line.character) {
        line.character = character;
        // A line moved to another track belongs to that role (and its player), not to the old one
        line.claimedBy = null;
        moved = true;
      }
      line.caption = caption;
      if (line.audioStart !== null && line.audioStart !== undefined) line.audioStart = Number((line.audioStart + delta).toFixed(3));
      if (line.recordedStart !== null && line.recordedStart !== undefined) line.recordedStart = Number((line.recordedStart + delta).toFixed(3));
      line.revision = Number(line.revision || 0) + 1;
      if (!room.trackOrder.includes(character)) room.trackOrder.push(character);
    }
    dropEmptyRoleClaims(room);
    room.lines.sort((a, b) => a.start - b.start || a.id - b.id);
    history.recordLines(conn.roomId, room, conn.clientId, before, claimsSnapshot, trackOrderBefore);
    room.updatedAt = Date.now();
    snapshotActive(room);
    saveRooms();
    const lines = planned.map(item => item.line);
    // Ownership, roles or tracks changed: everyone needs the whole scene, not just the lines
    if (moved || room.trackOrder.length !== tracksBefore || JSON.stringify(room.characterClaims) !== claimsBefore) emitSession(conn.roomId);
    else io.to(conn.roomId).emit('editor_lines_updated', lines);
    reply({ ok: true, line: lines[0], lines });
  }

  socket.on('editor_update_line', (data = {}, ack) => {
    updateLines([data], typeof ack === 'function' ? ack : () => {}, data.sessionId);
  });

  socket.on('editor_update_lines', ({ updates, sessionId } = {}, ack) => {
    updateLines(updates, typeof ack === 'function' ? ack : () => {}, sessionId);
  });

  socket.on('editor_delete_lines', ({ lines, sessionId } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!conn.roomId) return reply({ ok: false, reason: 'room' });
    const room = getRoom(conn.roomId);
    if (!editorAllowed(conn, room)) return reply({ ok: false, reason: 'mode' });
    if (sessionId !== undefined && sessionId !== room.activeSessionId) return reply({ ok: false, reason: 'session' });
    if (!Array.isArray(lines) || !lines.length || lines.length > 2000) return reply({ ok: false, reason: 'invalid' });
    const ids = new Set();
    const current = [];
    let conflict = false;
    for (const item of lines) {
      const id = Number(item && item.lineId);
      if (!item || !Number.isInteger(id) || ids.has(id)) return reply({ ok: false, reason: 'invalid' });
      ids.add(id);
      const line = room.lines.find(line => line.id === id);
      if (!line) return reply({ ok: false, reason: 'missing' });
      current.push(line);
      if (Number(item.revision) !== Number(line.revision || 0)) conflict = true;
    }
    if (conflict) return reply({ ok: false, reason: 'conflict', lines: current });
    const count = putInTrash(room, ids, conn.nick);
    if (!count) return reply({ ok: false, reason: 'missing' });
    history.record(conn.roomId, room, { by: conn.clientId, type: 'delete', batch: room.deletedLines[room.deletedLines.length - 1] });
    room.updatedAt = Date.now();
    snapshotActive(room);
    saveRooms();
    emitSession(conn.roomId);
    socket.emit('lines_deleted', { count });
    logEvent(conn.roomId, `✎ ${conn.nick} deleted ${count} editor lines`);
    reply({ ok: true, count });
  });
  // Ctrl+Z in Edit Mode: undo this player's own last edit. Lines someone else changed
  // afterwards are left alone and counted as skipped.
  socket.on('editor_undo', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : (typeof payload === 'function' ? payload : () => {});
    if (!conn.roomId) return reply({ ok: false, reason: 'room' });
    const room = getRoom(conn.roomId);
    if (!editorAllowed(conn, room)) return reply({ ok: false, reason: 'mode' });
    if (payload && payload.sessionId !== undefined && payload.sessionId !== room.activeSessionId) return reply({ ok: false, reason: 'session' });
    const entry = history.popFor(conn.roomId, room, conn.clientId);
    if (!entry) return reply({ ok: false, reason: 'empty' });
    normalizeEditorState(room);

    let undone = 0;
    let skipped = 0;
    if (entry.type === 'lines') {
      const trackOrderUntouched = entry.tracksBefore && entry.tracksAfter &&
        JSON.stringify(room.trackOrder) === JSON.stringify(entry.tracksAfter);
      for (const item of entry.lines) {
        const line = room.lines.find(l => l.id === item.id);
        if (!line || Number(line.revision || 0) !== item.revAfter) { skipped++; continue; }
        // Field by field: a value someone changed since (a claim while dubbing) stays as it is
        for (const [field, [before, after]] of Object.entries(item.changes)) {
          if ((line[field] === undefined ? null : line[field]) === after) line[field] = before;
        }
        // The take keeps its place relative to the line, even one recorded after this edit
        if (item.changes.start) {
          const delta = item.changes.start[0] - item.changes.start[1];
          if (line.audioStart !== null && line.audioStart !== undefined) line.audioStart = Number((line.audioStart + delta).toFixed(3));
          if (line.recordedStart !== null && line.recordedStart !== undefined) line.recordedStart = Number((line.recordedStart + delta).toFixed(3));
        }
        line.revision = Number(line.revision || 0) + 1;
        history.rebase(conn.roomId, room, conn.clientId, line.id, item.revBefore, line.revision);
        undone++;
      }
      // A moved role claim is one transition: freeing/reassigning either end afterwards
      // prevents undo from silently re-claiming the old role.
      const claimChanges = Object.entries(entry.claims || {});
      if (undone && !skipped && claimChanges.every(([character, [, after]]) => (room.characterClaims[character] || null) === after)) {
        for (const [character, [before]] of claimChanges) {
          if (before && room.lines.some(line => line.character === character)) room.characterClaims[character] = before;
          else delete room.characterClaims[character];
        }
      }
      if (!skipped && trackOrderUntouched) {
        room.trackOrder = [...entry.tracksBefore];
        if (!entry.lines.length) undone = 1;
      } else {
        const tracksUndone = entry.tracksBefore && entry.tracksAfter ? undoTrackChanges(room, entry.tracksBefore, entry.tracksAfter, !entry.lines.length) : 0;
        if (!entry.lines.length) {
          if (tracksUndone) undone = 1;
          else skipped = 1;
        }
      }
      for (const line of room.lines) if (!room.trackOrder.includes(line.character)) room.trackOrder.push(line.character);
      dropEmptyRoleClaims(room);
    } else if (entry.type === 'create') {
      const line = room.lines.find(l => l.id === entry.id);
      if (line && Number(line.revision || 0) === entry.revAfter && !line.audioUrl) {
        room.lines.splice(room.lines.indexOf(line), 1);
        dropEmptyRoleClaims(room);
        undone = 1;
      } else skipped = 1;
    } else if (entry.type === 'track') {
      if (!room.lines.some(l => l.character === entry.name)) {
        room.trackOrder = room.trackOrder.filter(name => name !== entry.name);
        delete room.characterClaims[entry.name];
        undone = 1;
      } else skipped = 1;
    } else if (entry.type === 'delete') {
      if (room.deletedLines.includes(entry.batch)) undone = restoreBatch(room, entry.batch);
      skipped = entry.batch.lines.length - undone;
    }

    room.lines.sort((a, b) => a.start - b.start || a.id - b.id);
    room.updatedAt = Date.now();
    snapshotActive(room);
    saveRooms();
    emitSession(conn.roomId);
    if (undone) logEvent(conn.roomId, `↶ ${conn.nick} undid an edit (${entry.type})`);
    reply({ ok: true, type: entry.type, undone, skipped, more: history.hasFor(conn.roomId, room, conn.clientId) });
  });
};
