// Undo for the collaborative editor: every player undoes their own last edit (Ctrl+Z).
// Kept in memory per room session; a server restart starts a fresh history.
const MAX_ENTRIES = 200;
const histories = new Map(); // `${roomId}:${sessionId}` -> [{ by, type, ... }]
const fieldVersions = new WeakMap(); // per live line; runtime only, protects same-field ABA
const groupOf = field => ['start', 'end'].includes(field) ? 'timing' : ['character', 'claimedBy'].includes(field) ? 'assignment' : field;
function versions(line) {
  if (!fieldVersions.has(line)) fieldVersions.set(line, { caption: 0, timing: 0, assignment: 0 });
  return fieldVersions.get(line);
}

// Fields an editor operation may change. Take placement (audioStart, recordedStart) is not
// stored: it follows the line's start on undo, so a take recorded later stays where it was put.
const LINE_FIELDS = ['start', 'end', 'character', 'caption', 'claimedBy'];

function keyOf(roomId, room) {
  return `${roomId}:${room.activeSessionId || ''}`;
}

// The state of a line before an edit; recordLines keeps only what the edit actually changed
function lineBefore(line) {
  return Object.fromEntries(LINE_FIELDS.map(field => [field, line[field] === undefined ? null : line[field]]));
}

function record(roomId, room, entry) {
  const key = keyOf(roomId, room);
  const list = histories.get(key) || [];
  list.push({ at: Date.now(), ...entry });
  while (list.length > MAX_ENTRIES) list.shift();
  histories.set(key, list);
}

// Record a change of several lines: `before` is a Map id -> lineBefore(line) taken before the change.
// Changed fields and the complete claim transition are kept as [before, after].
// A rename moves a claim between keys: undo must check both ends of that transition.
function recordLines(roomId, room, by, before, claimsBefore, trackOrderBefore) {
  const lines = [];
  for (const [id, state] of before) {
    const line = room.lines.find(item => item.id === id);
    if (!line) continue;
    const changes = {};
    for (const field of LINE_FIELDS) {
      const after = line[field] === undefined ? null : line[field];
      if (state[field] !== after) changes[field] = [state[field], after];
    }
    if (Object.keys(changes).length) {
      const revAfter = Number(line.revision || 0);
      const groups = [...new Set(Object.keys(changes).map(groupOf))];
      const clock = versions(line), groupBefore = {}, groupAfter = {};
      for (const group of groups) { groupBefore[group] = clock[group]; groupAfter[group] = ++clock[group]; }
      // Include both timing edges in preflight even if just one changed.
      lines.push({ id, revBefore: revAfter - 1, revAfter, changes, groupBefore, groupAfter,
        timingAfter: groups.includes('timing') ? [line.start, line.end] : null });
    }
  }
  const claims = Object.create(null);
  for (const character of new Set([...Object.keys(claimsBefore || {}), ...Object.keys(room.characterClaims)])) {
    const previous = claimsBefore && Object.hasOwn(claimsBefore, character) ? claimsBefore[character] : null;
    const current = room.characterClaims[character] || null;
    if (previous !== current) claims[character] = [previous, current];
  }
  const tracksBefore = Array.isArray(trackOrderBefore) ? [...trackOrderBefore] : null;
  const tracksAfter = tracksBefore ? [...(room.trackOrder || [])] : null;
  const tracksChanged = tracksBefore && JSON.stringify(tracksBefore) !== JSON.stringify(tracksAfter);
  if (lines.length || tracksChanged) {
    record(roomId, room, { by, type: 'lines', lines, claims, tracksBefore, tracksAfter });
  }
}

function popFor(roomId, room, actorId) {
  const list = histories.get(keyOf(roomId, room)) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].by === actorId) return list.splice(i, 1)[0];
  }
  return null;
}

function peekFor(roomId, room, actorId) {
  return (histories.get(keyOf(roomId, room)) || []).findLast(entry => entry.by === actorId) || null;
}

// Every edit and every undo raises a line's revision by one. After an undo the line is back in
// the state that this player's earlier edit left it in, so that edit stays undoable.
function rebase(roomId, room, actorId, lineId, fromRev, toRev) {
  for (const entry of histories.get(keyOf(roomId, room)) || []) {
    if (entry.by !== actorId) continue;
    if (entry.type === 'lines') entry.lines.forEach(item => { if (item.id === lineId && item.revAfter === fromRev) item.revAfter = toRev; });
    if (entry.type === 'create' && entry.id === lineId && entry.revAfter === fromRev) entry.revAfter = toRev;
  }
}

function hasFor(roomId, room, actorId) {
  return (histories.get(keyOf(roomId, room)) || []).some(entry => entry.by === actorId);
}

function canUndoLine(line, item) {
  if (!line) return false;
  if (item.groupAfter && Object.entries(item.groupAfter).some(([group, version]) => versions(line)[group] !== version)) return false;
  if (item.timingAfter && (line.start !== item.timingAfter[0] || line.end !== item.timingAfter[1])) return false;
  return Object.entries(item.changes).every(([field, [, after]]) => (line[field] ?? null) === after);
}

function noteUndo(roomId, room, actorId, line, item) {
  const clock = versions(line);
  for (const [group, previousVersion] of Object.entries(item.groupBefore || {})) {
    const nextVersion = ++clock[group];
    for (const entry of histories.get(keyOf(roomId, room)) || []) {
      if (entry.by !== actorId) continue;
      for (const prior of entry.lines || []) {
        if (prior.id === line.id && prior.groupAfter?.[group] === previousVersion) prior.groupAfter[group] = nextVersion;
      }
    }
  }
}

function clear(roomId, sessionId) {
  histories.delete(`${roomId}:${sessionId || ''}`);
}

function renameNick(roomId, oldName, newName) {
  for (const [key, list] of histories) {
    if (!key.startsWith(`${roomId}:`)) continue;
    for (const entry of list) {
      for (const line of entry.lines || []) {
        if (line.changes && line.changes.claimedBy) line.changes.claimedBy = line.changes.claimedBy.map(nick => nick === oldName ? newName : nick);
      }
      for (const char of Object.keys(entry.claims || {})) {
        entry.claims[char] = entry.claims[char].map(nick => nick === oldName ? newName : nick);
      }
    }
  }
}

module.exports = { lineBefore, record, recordLines, peekFor, popFor, hasFor, rebase, clear, renameNick, LINE_FIELDS, canUndoLine, noteUndo };
