const model = require('../public/voice-preset-model');
const fail = key => { throw Error('preset.' + key); };
function plan(room, conn, data, moderator) {
  if (!data || !['create', 'rename', 'update', 'delete'].includes(data.action) || !require('../public/voice-chain-model').id(data.id) || !Number.isSafeInteger(data.revision) || data.revision < 0) fail('invalid');
  if (data.icon !== undefined && !model.validIcon(data.icon)) fail('invalid');
  const next = Object.assign(Object.create(null), structuredClone(room.voicePresets || {})), previous = Object.hasOwn(next, data.id) ? next[data.id] : null;
  if (data.action === 'create') {
    if (previous || data.revision !== 0) fail('conflict');
    if (Object.keys(next).length >= model.MAX_PRESETS) fail('capacity');
    if (!model.name(data.name) || !model.validSettings(data.settings)) fail('invalid');
    next[data.id] = { id: data.id, name: data.name.trim(), ...structuredClone(data.settings), createdBy: conn.nick, revision: 1 };
  } else {
    if (!previous) fail('missing');
    if (!moderator && previous.createdBy !== conn.nick) fail('owner');
    if (data.revision !== previous.revision || previous.revision >= Number.MAX_SAFE_INTEGER) fail('conflict');
    if (data.action === 'delete') delete next[data.id];
    else {
      if (data.action === 'rename' && !model.name(data.name) || data.action === 'update' && !model.validSettings(data.settings)) fail('invalid');
      next[data.id] = data.action === 'rename' ? { ...previous, name: data.name.trim(), revision: previous.revision + 1 } :
        { id: previous.id, name: previous.name, ...structuredClone(data.settings), createdBy: previous.createdBy, revision: previous.revision + 1 };
    }
  }
  if (data.action !== 'delete' && data.icon !== undefined) { if (data.icon === 'voice') delete next[data.id].icon; else next[data.id].icon = data.icon; }
  else if (data.action === 'update' && previous.icon !== undefined) next[data.id].icon = previous.icon;
  if (!model.validLibrary(next)) fail('invalid');
  return next;
}
function planScene(room, conn, data, moderator) {
  const catalog = plan(room, conn, data, moderator), usage = model.usage(room, data.id), chain = require('../public/voice-chain-model');
  let lines = room.lines, roles = room.roleEffects, deletedLines = room.deletedLines;
  if (data.action === 'delete') {
    const deleted = (room.deletedLines || []).flatMap(batch => (batch.lines || []).map(entry => entry.line)).filter(Boolean);
    const used = usage.lines.length || usage.roles.length || (room.deletedLines || []).some(batch => Object.values(batch.roleEffects || {}).some(entry => entry?.voicePresetId === data.id)) || deleted.some(line => [line, ...(line.takeHistory || [])].some(take => take.voicePresetId === data.id));
    if (used && data.detach !== true) fail('inUse');
    if (used) {
      const newId = () => require('node:crypto').randomUUID();
      function detachRole(entry) { if (!entry || entry.voicePresetId !== data.id) return entry; const linked = chain.preset(room, entry); return { ...entry, voicePresetId: null, usePresetPitch: false, effects: [...(linked?.effects || []), ...entry.effects].map(effect => structuredClone(effect)), pitch: entry.usePresetPitch && linked?.pitch !== undefined ? linked.pitch : entry.pitch, revision: (entry.revision || 0) + 1 }; }
      const detachRoles = entries => Object.assign(Object.create(null), Object.fromEntries(Object.entries(entries || {}).map(([name, entry]) => [name, detachRole(entry)])));
      roles = detachRoles(room.roleEffects);
      function detachLine(original) {
        if (![original, ...(original.takeHistory || [])].some(take => take.voicePresetId === data.id) && !usage.roles.includes(original.character)) return original;
        const line = structuredClone(original);
        if (line.voicePresetId === data.id) Object.assign(line, model.detach(line, room, newId));
        line.takeHistory = (line.takeHistory || []).map(take => { if (take.voicePresetId !== data.id) return take; const detached = model.detach({ ...take, character: line.character }, room, newId); delete detached.character; return detached; });
        line.takeMixRevision = (line.takeMixRevision || 0) + 1; line.takeHistoryRevision = (line.takeHistoryRevision || 0) + 1;
        if (!Number.isSafeInteger(line.takeMixRevision) || !Number.isSafeInteger(line.takeHistoryRevision)) fail('invalid');
        return line;
      }
      lines = room.lines.map(detachLine);
      deletedLines = (room.deletedLines || []).map(batch => ({ ...batch, roleEffects: detachRoles(batch.roleEffects), lines: (batch.lines || []).map(entry => ({ ...entry, line: entry.line ? detachLine(entry.line) : entry.line })) }));
    }
  }
  const next = { ...room, voicePresets: catalog, roleEffects: roles, lines, deletedLines };
  try { require('./voiceChains').validateScene(next); for (const batch of next.deletedLines || []) { const trashRoles = Object.fromEntries(Object.entries({ ...next.roleEffects, ...batch.roleEffects }).filter(([, role]) => role)), trashLines = (batch.lines || []).map(entry => entry.line).filter(Boolean); require('./voiceChains').validateScene({ ...next, roleEffects: trashRoles, lines: trashLines, trackOrder: [...new Set([...next.trackOrder, ...Object.keys(trashRoles), ...trashLines.map(line => line.character)])] }); } } catch { fail('limit'); }
  return next;
}
function register(socket, conn) {
  require('./editorOperations').registerMutation(socket, conn, 'voice_preset_update', (data, ack) => {
    try {
      const rooms = require('./rooms'), room = rooms.getRoom(conn.roomId), auth = require('./auth');
      if (!conn.nick || !auth.isAuthorized(room, conn.nick, conn.clientId)) fail('owner');
      if (!room.loaded || !room.activeSessionId) fail('missing');
      if (data.action === 'delete' && !data.detach && require('./editHistory').usesPreset(conn.roomId, room, data.id)) fail('inUse');
      if (data.icon && data.icon !== 'voice' && require('./voiceChains').incompatible(conn.roomId, 2).length) fail('clientUpdate');
      const next = planScene(room, conn, data, auth.canModerate(room, conn.clientId));
      const previous = { voicePresets: room.voicePresets, roleEffects: room.roleEffects, lines: room.lines, deletedLines: room.deletedLines, updatedAt: room.updatedAt };
      for (const key of ['voicePresets', 'roleEffects', 'lines', 'deletedLines']) room[key] = next[key]; room.updatedAt = Date.now();
      try { rooms.flushRooms({ strict: true }); }
      catch { Object.assign(room, previous); rooms.snapshotActive(room); fail('storage'); }
      if (data.action === 'delete') require('./editHistory').detachPreset(conn.roomId, room, { ...room, ...previous }, data.id);
      require('./app').io.to(conn.roomId).emit('voice_presets_updated', { sessionId: room.activeSessionId, voicePresets: room.voicePresets, ...(data.action === 'delete' ? { roleEffects: room.roleEffects, lines: room.lines.filter(line => line !== previous.lines.find(old => old.id === line.id)) } : {}), editorProtocol: require('./editorOperations').snapshotProtocol(room) });
      ack({ ok: true, voicePresets: room.voicePresets });
    } catch (error) { ack({ ok: false, reason: error.message.startsWith('preset.') ? error.message : 'preset.invalid' }); }
  });
}
module.exports = { model, plan, planScene, register };
