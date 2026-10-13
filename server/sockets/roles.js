// Roles and lines: claim/release, line characters, take settings, recording status
const { VOICE_EFFECTS, MAX_PITCH, MAX_TAKE_SHIFT } = require('../config');
const { recordingNow } = require('../state');
const { sanitizeChatText } = require('../sanitize');
const { logEvent } = require('../log');
const { saveRooms, flushRooms, getRoom, emitSession, dropEmptyRoleClaims, snapshotActive } = require('../rooms');
const { broadcastRecording, addSystemMessage } = require('../presence');
const { canModerate, isAuthorized, getLineOwner } = require('../auth');
const takeMix = require('../../public/take-mix');
const history = require('../editHistory');
const { registerMutation } = require('../editorOperations');

module.exports = function registerRoleHandlers(socket, conn) {
  require('../noiseReduction').register(socket, conn);
  require('../voiceChains').register(socket, conn);
  registerMutation(socket, conn, 'set_needs_retake', ({ lineId, audioUrl, takeMixRevision, retakeRevision, value, comment } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const room = getRoom(conn.roomId), line = room.lines.find(item => item.id === lineId);
    if (!line?.audioUrl || typeof value !== 'boolean') return reply({ ok: false, reason: 'invalid' });
    if (!(canModerate(room, conn.clientId) || line.recordedBy === conn.nick || getLineOwner(room, line) === conn.nick)) return reply({ ok: false, reason: 'owner' });
    const legacy = retakeRevision === undefined;
    if (comment !== undefined && (legacy || typeof comment !== 'string' || comment.length > require('../retakes').MAX_COMMENT)) return reply({ ok: false, reason: 'invalid' });
    if (audioUrl !== line.audioUrl || (legacy ? takeMixRevision !== (line.takeMixRevision || 0) : retakeRevision !== (line.retakeRevision || 0))) return reply({ ok: false, reason: 'conflict', line });
    const nextComment = value ? comment ?? line.retakeComment ?? '' : '';
    if (line.needsRetake === value && (line.retakeComment || '') === nextComment) return reply({ ok: true, changed: false, line });
    if ((line.retakeRevision || 0) >= Number.MAX_SAFE_INTEGER) return reply({ ok: false, reason: 'conflict', line });
    Object.assign(line, { needsRetake: value, retakeComment: nextComment, retakeRevision: (line.retakeRevision || 0) + 1 });
    if (legacy) line.takeMixRevision = (line.takeMixRevision || 0) + 1;
    flushRooms();
    require('../sessionScope').emitLines(conn.roomId, [line]);
    const owner = getLineOwner(room, line);
    if (value && owner && owner !== conn.nick) {
      const { roomSockets } = require('../state');
      for (const [id, member] of Object.entries(roomSockets[conn.roomId] || {})) if (member.nick === owner && isAuthorized(room, member.nick, member.clientId)) {
        require('../app').io.to(id).emit('retake_notice', { sessionId: room.activeSessionId, lineId: line.id, revision: line.retakeRevision, by: conn.nick });
      }
    }
    reply({ ok: true, changed: true, line });
  });
  // Allocate order before recording starts, not when its asynchronous processing finishes.
  socket.on('reserve_take', ({ lineId, sessionId, cancelSequence, historyResume, expectedTakeId, historyRevision } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (!conn.roomId || !conn.nick) return ack({ ok: false, reason: 'nick' });
    const room = getRoom(conn.roomId);
    if (!isAuthorized(room, conn.nick, conn.clientId)) return ack({ ok: false, reason: 'owner' });
    snapshotActive(room);
    const target = sessionId === room.activeSessionId ? room : room.sessions[sessionId];
    const line = target && target.lines.find(item => item.id === lineId);
    if (!line || (room.singlePlayer ? room.host : getLineOwner(target, line)) !== conn.nick) return ack({ ok: false, reason: 'owner' });
    if (cancelSequence !== undefined) {
      if (!Number.isSafeInteger(cancelSequence) || cancelSequence < 1 || cancelSequence > (line.takeCounter || 0)) return ack({ ok: false, reason: 'invalid' });
      // Cancel only this reserved sequence; never invalidate a newer recording.
      if (cancelSequence > (line.takeSequence || 0)) {
        if (cancelSequence !== line.takeCounter) return ack({ ok: false, reason: 'conflict' });
        try { require('../takeHistory').commit(room, target, line, { ...line, takeSequence: cancelSequence }); }
        catch (error) { return ack({ ok: false, reason: error.key || 'takeHistory.storage' }); }
        if (sessionId === room.activeSessionId) require('../sessionScope').emitLines(conn.roomId, [line]);
      }
      return ack({ ok: true, cancelled: true });
    }
    if (target.mode === 'edit') return ack({ ok: false, reason: 'mode' });
    if (historyResume) {
      if (expectedTakeId !== (line.takeId || null) || historyRevision !== (line.takeHistoryRevision || 0)) return ack({ ok: false, reason: 'takeHistory.changed' });
      const next = structuredClone(line);
      try {
        require('../takeHistory').invalidateReservations(next);
        next.takeCounter++;
        if (!Number.isSafeInteger(next.takeCounter)) throw require('../takeHistory').failure('invalid');
        require('../takeHistory').commit(room, target, line, next);
      } catch (error) { return ack({ ok: false, reason: error.key || 'takeHistory.storage' }); }
      return ack({ ok: true, takeSequence: line.takeCounter });
    }
    const nextCounter = Math.max(Number(line.takeCounter) || 0, Number(line.takeSequence) || 0) + 1;
    if (!Number.isSafeInteger(nextCounter)) return ack({ ok: false, reason: 'takeHistory.invalid' });
    try { require('../takeHistory').commit(room, target, line, { ...line, takeCounter: nextCounter }); }
    catch (error) { return ack({ ok: false, reason: error.key || 'takeHistory.storage' }); }
    ack({ ok: true, takeSequence: line.takeCounter });
  });

  socket.on('claim_character', ({ character } = {}) => {
    if (!conn.roomId || !conn.nick) return;
    const room = getRoom(conn.roomId);
    if (room.characterClaims[character]) return;

    room.characterClaims[character] = conn.nick;
    room.lines.forEach(l => {
      if (l.character === character) l.claimedBy = conn.nick;
    });
    saveRooms();
    emitSession(conn.roomId);
  });

  // A role can be released by its owner or the host
  socket.on('unclaim_character', ({ character } = {}) => {
    if (!conn.roomId || !conn.nick) return;
    const room = getRoom(conn.roomId);
    const owner = room.characterClaims[character];
    if (!owner || (owner !== conn.nick && !canModerate(room, conn.clientId))) return;

    delete room.characterClaims[character];
    room.lines.forEach(l => {
      if (l.character === character && l.claimedBy === owner) l.claimedBy = null;
    });
    saveRooms();
    emitSession(conn.roomId);
    if (owner !== conn.nick) addSystemMessage(conn.roomId, 'system.roleReleasedBy', { character, owner, by: conn.nick });
  });

  socket.on('claim_line', ({ lineId, sessionId, audioUrl } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!conn.roomId || !conn.nick) return reply({ ok: false, reason: 'room' });
    const room = getRoom(conn.roomId);
    if (sessionId !== undefined && sessionId !== room.activeSessionId) return reply({ ok: false, reason: 'session' });
    if (typeof ack === 'function' && (sessionId === undefined || room.mode === 'edit')) return reply({ ok: false, reason: 'mode' });
    const line = room.lines.find(l => l.id === lineId);
    if (!line) return reply({ ok: false, reason: 'missing' });
    if (audioUrl !== undefined && audioUrl !== line.audioUrl) return reply({ ok: false, reason: 'take' });

    const charOwner = room.characterClaims[line.character];
    if (charOwner && charOwner !== conn.nick) return reply({ ok: false, reason: 'owner', owner: charOwner });
    if (!line.claimedBy || line.claimedBy === conn.nick) {
      line.claimedBy = conn.nick;
      saveRooms();
      require('../sessionScope').emitLines(conn.roomId, [line]);
      return reply({ ok: true, line, sessionId: room.activeSessionId });
    }
    reply({ ok: false, reason: 'owner', owner: line.claimedBy });
  });

  socket.on('unclaim_line', ({ lineId } = {}) => {
    if (!conn.roomId || !conn.nick) return;
    const room = getRoom(conn.roomId);
    const line = room.lines.find(l => l.id === lineId);
    if (!line || !line.claimedBy) return;
    if (room.characterClaims[line.character]) return;

    const owner = line.claimedBy;
    if (owner !== conn.nick && !canModerate(room, conn.clientId)) return;

    line.claimedBy = null;
    saveRooms();
    require('../sessionScope').emitLines(conn.roomId, [line]);
    if (owner !== conn.nick) addSystemMessage(conn.roomId, 'system.lineReleasedBy', { id: line.id, owner, by: conn.nick });
  });

  // Captured take identity prevents settings from reaching replacement recordings.
  // Validate the entire batch before changing any line.
  function updateTakes(data, ack, bulk) {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!data || typeof data !== 'object' || !conn.roomId || !conn.nick) return reply({ ok: false, reason: 'room' });
    const room = getRoom(conn.roomId);
    if (!isAuthorized(room, conn.nick, conn.clientId)) return reply({ ok: false, reason: 'owner' });
    if (data.sessionId !== room.activeSessionId) return reply({ ok: false, reason: 'session' });
    const targets = bulk ? data.takes : [data];
    const props = bulk ? data.props : data;
    if (!Array.isArray(targets) || !targets.length || targets.length > 2000 || !props || typeof props !== 'object') return reply({ ok: false, reason: 'invalid' });
    const patch = {};
    for (const field of Object.keys(takeMix.DEFAULTS)) {
      if (Object.hasOwn(props, field)) {
        if (!takeMix.valid(field, props[field])) return reply({ ok: false, reason: 'invalid' });
        patch[field] = props[field];
      }
    }
    if (Object.hasOwn(props, 'effect')) {
      if (!VOICE_EFFECTS.includes(props.effect)) return reply({ ok: false, reason: 'invalid' });
      patch.effect = props.effect;
    }
    if (Object.hasOwn(props, 'pitch')) {
      const pitch = Math.round(Number(props.pitch));
      if (!Number.isFinite(pitch)) return reply({ ok: false, reason: 'invalid' });
      patch.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
    }
    if (Object.hasOwn(props, 'trimEnabled')) {
      if (typeof props.trimEnabled !== 'boolean') return reply({ ok: false, reason: 'invalid' });
      patch.trimEnabled = props.trimEnabled;
    }
    if (Object.hasOwn(props, 'audioStart')) {
      if (bulk || typeof props.audioStart !== 'number' || !Number.isFinite(props.audioStart)) return reply({ ok: false, reason: 'invalid' });
      patch.audioStart = props.audioStart;
    }
    if (!Object.keys(patch).length) return reply({ ok: false, reason: 'invalid' });
    const seen = new Set(), lines = [];
    for (const target of targets) {
      if (!target || seen.has(target.lineId)) return reply({ ok: false, reason: 'invalid' });
      seen.add(target.lineId);
      const line = room.lines.find(item => item.id === target.lineId);
      if (!line || !takeMix.canEdit(line, conn.nick, canModerate(room, conn.clientId), getLineOwner(room, line))) return reply({ ok: false, reason: 'owner' });
      if (target.audioUrl !== line.audioUrl || (bulk && !line.audioUrl)) return reply({ ok: false, reason: 'take' });
      if ((bulk || target.takeMixRevision !== undefined) && (!Number.isSafeInteger(target.takeMixRevision) || target.takeMixRevision !== (line.takeMixRevision || 0))) return reply({ ok: false, reason: 'conflict' });
      lines.push(line);
    }
    const voiceModel = require('../../public/voice-chain-model');
    for (const line of lines) {
      const next = { ...line, ...patch };
      if (patch.pitch !== undefined) next.pitchMode = 'override';
      if (Array.isArray(line.effects) && (patch.effect !== undefined || patch.effectAmount !== undefined)) {
        if (patch.effect !== undefined) next.effects = patch.effect === 'none' ? [] : [{ id: require('crypto').randomUUID(), type: patch.effect, enabled: true, amount: patch.effectAmount ?? 1, parameters: {} }];
        else if (line.effects.length === 1) next.effects = [{ ...line.effects[0], amount: patch.effectAmount }];
        else return reply({ ok: false, reason: 'invalid' });
      }
      if (!voiceModel.safe(voiceModel.resolve(next, room))) return reply({ ok: false, reason: 'fx.limit' });
    }
    for (const line of lines) {
      const applied = { ...patch };
      if (applied.pitch !== undefined) applied.pitchMode = 'override';
      if (Array.isArray(line.effects) && (applied.effect !== undefined || applied.effectAmount !== undefined)) applied.effects = applied.effect !== undefined ? (applied.effect === 'none' ? [] : [{ id: require('crypto').randomUUID(), type: applied.effect, enabled: true, amount: applied.effectAmount ?? 1, parameters: {} }]) : [{ ...line.effects[0], amount: applied.effectAmount }];
      if (applied.audioStart !== undefined && line.audioUrl) {
        const min = Math.max(-5, line.start - MAX_TAKE_SHIFT);
        applied.audioStart = Number(Math.max(min, Math.min(line.start + MAX_TAKE_SHIFT, applied.audioStart)).toFixed(3));
      } else delete applied.audioStart;
      Object.assign(line, applied);
      line.takeMixRevision = (line.takeMixRevision || 0) + 1;
    }
    saveRooms();
    require('../sessionScope').emitLines(conn.roomId, lines, bulk);
    reply({ ok: true, updated: lines.length });
  }
  socket.on('set_take_props', (data, ack) => updateTakes(data, ack, false));
  socket.on('set_takes_props', (data, ack) => updateTakes(data, ack, true));

  socket.on('host_reset_claims', () => {
    if (!conn.roomId) return;
    const room = getRoom(conn.roomId);
    if (!canModerate(room, conn.clientId)) return;

    room.characterClaims = Object.create(null);
    room.lines.forEach(l => { l.claimedBy = null; });
    saveRooms();
    emitSession(conn.roomId);
    addSystemMessage(conn.roomId, 'system.claimsResetBy', { by: conn.nick }, `♻️ ${conn.nick} released all roles and lines (recorded takes are kept)`);
  });

  // ---------- Line characters: moving lines to another track ----------
  // `before` collects the lines' previous state for undo (Ctrl+Z in Edit Mode)
  function moveLine(room, line, name, before) {
    const oldName = line.character;
    if (oldName === name) return false;
    before.set(line.id, history.lineBefore(line));
    // The line now belongs to the new role (and whoever claimed it), not to the old owner
    line.claimedBy = null;
    line.character = name;
    line.revision = Number(line.revision || 0) + 1;
    return true;
  }

  function cleanCharacterName(raw) {
    return sanitizeChatText(raw).slice(0, 40);
  }

  registerMutation(socket, conn, 'set_line_character', (data = {}, ack) => {
    const { lineId, revision, character, sessionId, dubAssignment } = data;
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!conn.roomId || !conn.nick) return reply({ ok: false, reason: 'room' });
    const room = getRoom(conn.roomId);
    if (room.mode !== 'edit' && !(room.mode === 'dub' && dubAssignment === true) || room.mode === 'edit' && dubAssignment) return reply({ ok: false, reason: 'mode' });
    if (sessionId !== undefined && sessionId !== room.activeSessionId) return reply({ ok: false, reason: 'session' });
    const line = room.lines.find(l => l.id === lineId);
    const name = cleanCharacterName(character);
    if (!line) return reply({ ok: false, reason: 'missing' });
    if (Number(revision) !== Number(line.revision || 0)) return reply({ ok: false, reason: 'conflict', line });
    if (!name) return reply({ ok: false, reason: 'invalid' });
    if (room.mode === 'dub') {
      if (!room.trackOrder.includes(name)) return reply({ ok: false, reason: 'missing' });
      const owner = getLineOwner(room, line), targetOwner = room.singlePlayer ? room.host : room.characterClaims[name] || null;
      if (!canModerate(room, conn.clientId) && (owner !== conn.nick || targetOwner && targetOwner !== conn.nick)) return reply({ ok: false, reason: 'owner' });
      if (data.expectedOwner !== owner || data.expectedTargetOwner !== targetOwner || data.audioUrl !== line.audioUrl || data.takeCounter !== (line.takeCounter || 0)) return reply({ ok: false, reason: 'conflict', line });
      if (recordingNow[conn.roomId]?.[line.id] || (line.takeCounter || 0) > (line.takeSequence || 0)) return reply({ ok: false, reason: 'pending' });
    }
    const oldName = line.character;
    try { require('../voiceChains').checkTransfers(room, new Map([[line.id, name]])); } catch { return reply({ ok: false, reason: 'fx.limit' }); }
    const before = new Map();
    const claimsBefore = { ...room.characterClaims };
    if (!Array.isArray(room.trackOrder)) room.trackOrder = [];
    const trackOrderBefore = [...room.trackOrder];
    if (!moveLine(room, line, name, before)) return reply({ ok: true, moved: 0, line });
    if (!room.trackOrder.includes(name)) room.trackOrder.push(name);
    dropEmptyRoleClaims(room);
    history.recordLines(conn.roomId, room, conn.clientId, before, claimsBefore, trackOrderBefore);
    saveRooms();
    emitSession(conn.roomId);
    logEvent(conn.roomId, `✎ ${conn.nick}: line #${line.id}: "${oldName}" → "${name}"`);
    reply({ ok: true, moved: 1, line });
  });

  // Several selected lines at once. Revisions make the operation atomic.
  registerMutation(socket, conn, 'set_lines_character', ({ lines, character, sessionId } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!conn.roomId || !conn.nick || !Array.isArray(lines) || !lines.length || lines.length > 2000) {
      return reply({ ok: false, reason: 'invalid', moved: 0, skipped: 0 });
    }
    const room = getRoom(conn.roomId);
    if (room.mode !== 'edit') return reply({ ok: false, reason: 'mode', moved: 0, skipped: lines.length });
    if (sessionId !== undefined && sessionId !== room.activeSessionId) return reply({ ok: false, reason: 'session' });
    const name = cleanCharacterName(character);
    if (!name) return reply({ ok: false, reason: 'invalid', moved: 0, skipped: lines.length });
    const expected = new Map();
    for (const item of lines) {
      const id = Number(item && item.lineId);
      if (!Number.isFinite(id) || expected.has(id) || !Number.isFinite(Number(item.revision))) {
        return reply({ ok: false, reason: 'invalid', moved: 0, skipped: lines.length });
      }
      expected.set(id, Number(item.revision));
    }
    const selected = [];
    for (const [id, revision] of expected) {
      const line = room.lines.find(item => item.id === id);
      if (!line) return reply({ ok: false, reason: 'missing', moved: 0, skipped: lines.length });
      selected.push(line);
    }
    const conflicts = selected.filter(line => expected.get(line.id) !== Number(line.revision || 0));
    if (conflicts.length) return reply({ ok: false, reason: 'conflict', moved: 0, skipped: lines.length, lines: conflicts });
    try { require('../voiceChains').checkTransfers(room, new Map(selected.map(line => [line.id, name]))); } catch { return reply({ ok: false, reason: 'fx.limit', moved: 0 }); }

    let moved = 0;
    const before = new Map();
    const claimsBefore = { ...room.characterClaims };
    if (!Array.isArray(room.trackOrder)) room.trackOrder = [];
    const trackOrderBefore = [...room.trackOrder];
    selected.forEach(line => { if (moveLine(room, line, name, before)) moved++; });
    if (moved) {
      if (!room.trackOrder.includes(name)) room.trackOrder.push(name);
      dropEmptyRoleClaims(room);
      history.recordLines(conn.roomId, room, conn.clientId, before, claimsBefore, trackOrderBefore);
      saveRooms();
      emitSession(conn.roomId);
      logEvent(conn.roomId, `✎ ${conn.nick}: ${moved} lines → "${name}"`);
    }
    reply({ ok: true, moved, skipped: 0, lines: selected });
  });

  // Rename a whole track (all of a character's lines); an existing name means a merge
  registerMutation(socket, conn, 'rename_character', ({ from, to, lines: expectedLines, targetLines, trackOrder, expectedClaims, sessionId } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (!conn.roomId || !conn.nick) return reply({ ok: false });
    const room = getRoom(conn.roomId);
    if (room.mode !== 'edit') return reply({ ok: false, reason: 'mode' });
    if (sessionId !== undefined && sessionId !== room.activeSessionId) return reply({ ok: false, reason: 'session' });
    if (!Array.isArray(room.trackOrder)) room.trackOrder = [];
    const hasTrack = room.trackOrder.includes(from);
    const name = cleanCharacterName(to);
    const lines = room.lines.filter(l => l.character === from);
    if (!name || (!lines.length && !hasTrack) || name === from || !Array.isArray(expectedLines)) {
      return reply({ ok: false, reason: 'invalid' });
    }
    const expected = new Map();
    for (const item of expectedLines) {
      const id = Number(item && item.lineId);
      if (!Number.isFinite(id) || expected.has(id) || !Number.isFinite(Number(item.revision))) {
        return reply({ ok: false, reason: 'invalid' });
      }
      expected.set(id, Number(item.revision));
    }
    const staleSet = expected.size !== lines.length || lines.some(line => !expected.has(line.id));
    const conflicts = lines.filter(line => expected.get(line.id) !== Number(line.revision || 0));
    if (staleSet || conflicts.length) return reply({ ok: false, reason: 'conflict', lines });
    if (trackOrder !== undefined && JSON.stringify(trackOrder) !== JSON.stringify(room.trackOrder)) return reply({ ok: false, reason: 'conflict', lines });
    if (expectedClaims && ((room.characterClaims[from] || null) !== expectedClaims.from || (room.characterClaims[name] || null) !== expectedClaims.to)) return reply({ ok: false, reason: 'conflict', lines });
    if (targetLines !== undefined) {
      const targets = room.lines.filter(line => line.character === name);
      if (!Array.isArray(targetLines) || targetLines.length !== targets.length || targets.some(line => !targetLines.some(expected => expected.lineId === line.id && expected.revision === (line.revision || 0)))) return reply({ ok: false, reason: 'conflict', lines });
    }
    const roleOwner = room.characterClaims[from];
    const voiceBefore = structuredClone(room.roleEffects || {});
    require('../voiceChains').rename(room, from, name);
    const before = new Map(lines.map(line => [line.id, history.lineBefore(line)]));
    const claimsBefore = { ...room.characterClaims };
    const trackOrderBefore = [...room.trackOrder];
    lines.forEach(line => {
      line.character = name;
      line.revision = Number(line.revision || 0) + 1;
    });
    room.trackOrder = [...new Set(room.trackOrder.map(track => track === from ? name : track))];
    // A claimed role moves with the track if the new name is free
    if (roleOwner && !room.characterClaims[name]) room.characterClaims[name] = roleOwner;
    delete room.characterClaims[from];
    if (roleOwner && room.characterClaims[name] !== roleOwner) lines.forEach(line => { if (!line.claimedBy) line.claimedBy = roleOwner; });
    dropEmptyRoleClaims(room);
    history.recordLines(conn.roomId, room, conn.clientId, before, claimsBefore, trackOrderBefore, voiceBefore);
    saveRooms();
    emitSession(conn.roomId);
    logEvent(conn.roomId, `✎ ${conn.nick}: track "${from}" → "${name}" (${lines.length} lines)`);
    reply({ ok: true, moved: lines.length, lines });
  });

  // The host releases selected lines someone claimed by mistake
  socket.on('host_release_lines', ({ lineIds } = {}) => {
    if (!conn.roomId || !Array.isArray(lineIds)) return;
    const room = getRoom(conn.roomId);
    if (!canModerate(room, conn.clientId)) return;
    let released = 0;
    for (const id of lineIds) {
      const line = room.lines.find(l => l.id === id);
      if (line && line.claimedBy && !room.characterClaims[line.character]) {
        line.claimedBy = null;
        released++;
      }
    }
    if (!released) return;
    saveRooms();
    emitSession(conn.roomId);
    logEvent(conn.roomId, `👑 ${conn.nick} released lines: ${released}`);
  });

  // ---------- Recording status ----------
  socket.on('recording_status', ({ lineId, recording } = {}) => {
    if (!conn.roomId || !conn.nick) return;
    const room = getRoom(conn.roomId);
    if (room.mode === 'edit') return;
    const line = room.lines.find(l => l.id === lineId);
    if (!line) return;
    const map = recordingNow[conn.roomId] || (recordingNow[conn.roomId] = {});

    if (recording) {
      if (getLineOwner(room, line) !== conn.nick) return;
      map[lineId] = { nick: conn.nick, socketId: socket.id };
      logEvent(conn.roomId, `🔴 ${conn.nick} is recording line #${lineId}`);
    } else if (map[lineId] && map[lineId].socketId === socket.id) {
      delete map[lineId];
    } else {
      return;
    }
    broadcastRecording(conn.roomId);
  });
};
