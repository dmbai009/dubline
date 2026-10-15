const model = require('../public/voice-chain-model');
const takeMix = require('../public/take-mix');
const failure = key => { throw Error('fx.' + key); };
function validateScene(scene) {
  if (!model.validRoles(scene.roleEffects || {}, scene.trackOrder || [])) failure('invalid');
  for (const name of scene.trackOrder || []) if (!model.references(model.role(scene, name), scene) || !model.safe(model.roleVoice(scene, name))) failure('limit');
  for (const line of scene.lines) for (const variant of [line, ...(line.takeHistory || [])]) {
    const settings = model.take(variant);
    if (!model.validTake(settings) || !model.references(settings, scene) || !model.safe(model.resolve({ ...line, ...variant }, scene))) failure('limit');
  }
}
function plan(room, conn, data, moderator, owner) {
  if (!data || !['role', 'takes'].includes(data.scope)) failure('invalid');
  const roles = structuredClone(room.roleEffects || {}), lines = [];
  Object.setPrototypeOf(roles, null);
  if (data.scope === 'role') {
    if (!moderator) failure('owner');
    if (!room.trackOrder.includes(data.character)) failure('missing');
    const previous = model.role(room, data.character);
    if (previous.voicePresetId && data.previousPresetRevision !== model.preset(room, previous)?.revision) failure('conflict');
    if (data.settings?.voicePresetId && data.presetRevision !== model.preset(room, data.settings)?.revision) failure('conflict');
    if (!Number.isSafeInteger(data.revision) || data.revision !== (previous.revision || 0)) failure('conflict');
    if (!data.settings || !model.validEffects(data.settings.effects) || !Number.isFinite(data.settings.pitch) || Math.abs(data.settings.pitch) > 12) failure('invalid');
    if (data.settings.voicePresetId != null && !model.id(data.settings.voicePresetId) || data.settings.usePresetPitch !== undefined && typeof data.settings.usePresetPitch !== 'boolean') failure('invalid');
    roles[data.character] = { voicePresetId: data.settings.voicePresetId ?? null, usePresetPitch: data.settings.usePresetPitch ?? false, pitch: data.settings.pitch, effects: structuredClone(data.settings.effects), revision: (previous.revision || 0) + 1 };
  } else {
    if (['editPitch', 'editInheritance', 'editExceptions', 'editPreset'].some(key => data[key] !== undefined && typeof data[key] !== 'boolean')) failure('invalid');
    if (!Array.isArray(data.takes) || !data.takes.length || data.takes.length > 2000 || !['replace', 'append', 'clear', 'inherit', 'detach'].includes(data.action)) failure('invalid');
    if (['replace', 'append'].includes(data.action) && !model.validTake(data.settings)) failure('invalid');
    if (data.action === 'inherit' && typeof data.value !== 'boolean') failure('invalid');
    const seen = new Set();
    for (const target of data.takes) {
      if (!target || seen.has(target.lineId)) failure('invalid'); seen.add(target.lineId);
      const line = room.lines.find(item => item.id === target.lineId);
      if (!line || !takeMix.canEdit(line, conn.nick, moderator, owner(line))) failure('owner');
      if (target.character !== line.character || target.takeId !== (line.takeId || null) || target.audioUrl !== line.audioUrl || target.takeMixRevision !== (line.takeMixRevision || 0)) failure('conflict');
      if (line.voicePresetId && target.presetRevision !== model.preset(room, line)?.revision) failure('conflict');
      if (data.settings?.voicePresetId && data.presetRevision !== model.preset(room, data.settings)?.revision) failure('conflict');
      const next = structuredClone(line), settings = model.take(line);
      const incoming = data.settings && structuredClone(data.settings);
      if (incoming && data.takes.length > 1) incoming.effects = incoming.effects.map(effect => ({ ...effect, id: require('node:crypto').randomUUID() }));
      if (data.action === 'replace') {
        const previous = structuredClone(settings); Object.assign(settings, incoming);
        if (data.takes.length > 1) { if (!data.editPitch) settings.pitchMode = previous.pitchMode; if (!data.editInheritance) settings.inheritRoleEffects = previous.inheritRoleEffects; if (!data.editExceptions) settings.excludedRoleEffectIds = previous.excludedRoleEffectIds; if (!data.editPreset) { settings.voicePresetId = previous.voicePresetId; settings.usePresetPitch = previous.usePresetPitch; } }
      }
      if (data.action === 'append') settings.effects.push(...incoming.effects);
      if (data.action === 'clear') settings.effects = [];
      if (data.action === 'inherit') settings.inheritRoleEffects = data.value;
      if (data.action === 'detach') { const detached = require('../public/voice-preset-model').detach(line, room, () => require('node:crypto').randomUUID()); Object.assign(settings, model.take(detached)); next.pitch = detached.pitch; }
      if (settings.voicePresetId && ['append', 'clear'].includes(data.action)) failure('linked');
      if (!model.validTake(settings)) failure('limit');
      Object.assign(next, settings);
      if (data.pitch !== undefined) { if (!Number.isFinite(data.pitch) || Math.abs(data.pitch) > 12) failure('invalid'); if (data.action === 'replace' && (data.takes.length === 1 || data.editPitch === true)) next.pitch = data.pitch;
        if (data.action === 'append' && data.editPitch === true) { next.pitch = data.pitch; next.pitchMode = 'override'; } }
      next.effect = 'none'; next.effectAmount = 1;
      next.takeMixRevision = (line.takeMixRevision || 0) + 1;
      if (!Number.isSafeInteger(next.takeMixRevision)) failure('invalid');
      lines.push(next);
    }
  }
  const replacements = new Map(lines.map(line => [line.id, line]));
  validateScene({ ...room, roleEffects: roles, lines: room.lines.map(line => replacements.get(line.id) || line) });
  return { roles, lines };
}
const requiresClient = room => room.projectAudio?.normalizeVoices === true || Object.values(room.roleEffects || {}).some(role => role.voicePresetId) || (room.lines || []).some(line => [line, ...(line.takeHistory || [])].some(take => take.voicePresetId));
const incompatible = roomId => Object.entries(require('./state').roomSockets[roomId] || {}).filter(([, member]) => member.voiceVersion !== 1).map(([id]) => id);
function enforce(roomId, room) { if (requiresClient(room)) for (const id of incompatible(roomId)) { const socket = require('./app').io.sockets.sockets.get(id); socket?.emit('join_denied', { reason: 'voiceVersion' }); socket?.disconnect(true); } }
function register(socket, conn) {
  require('./editorOperations').registerMutation(socket, conn, 'voice_update', (data, ack) => {
    try {
      const rooms = require('./rooms'), room = rooms.getRoom(conn.roomId), auth = require('./auth');
      if (data.settings?.voicePresetId && incompatible(conn.roomId).length) failure('clientUpdate');
      const next = plan(room, conn, data, auth.canModerate(room, conn.clientId), line => auth.getLineOwner(room, line));
      const previousRoles = room.roleEffects, previousAt = room.updatedAt;
      const originals = next.lines.map(line => room.lines.find(item => item.id === line.id)), copies = originals.map(line => structuredClone(line));
      room.roleEffects = next.roles; originals.forEach((line, i) => Object.assign(line, next.lines[i])); room.updatedAt = Date.now();
      try { rooms.flushRooms({ strict: true }); }
      catch { room.roleEffects = previousRoles; room.updatedAt = previousAt; originals.forEach((line, i) => { for (const key of Object.keys(line)) delete line[key]; Object.assign(line, copies[i]); }); rooms.snapshotActive(room); failure('storage'); }
      require('./app').io.to(conn.roomId).emit('voice_updated', { sessionId: room.activeSessionId, character: data.scope === 'role' ? data.character : null,
        roleEffects: room.roleEffects, lines: next.lines, editorProtocol: require('./editorOperations').snapshotProtocol(room) });
      ack({ ok: true, updated: next.lines.length });
    } catch (error) { ack({ ok: false, reason: error.message.startsWith('fx.') ? error.message : 'fx.invalid' }); }
  });
}
// Existing roles use names. Rename transfers their one shared definition; merge
// keeps the destination definition, including an explicitly empty destination.
function rename(room, from, to) {
  const roles = room.roleEffects || {};
  if (Object.hasOwn(roles, from) && !room.trackOrder.includes(to)) roles[to] = structuredClone(roles[from]);
  delete roles[from]; room.roleEffects = roles;
}
function checkTransfers(room, assignments, removed = null) {
  const roles = structuredClone(room.roleEffects || {}), tracks = new Set(room.trackOrder);
  Object.setPrototypeOf(roles, null);
  if (removed) { delete roles[removed]; tracks.delete(removed); }
  for (const name of assignments.values()) tracks.add(name);
  validateScene({ ...room, roleEffects: roles, trackOrder: [...tracks], lines: room.lines.map(line => assignments.has(line.id) ? { ...line, character: assignments.get(line.id) } : line) });
}
module.exports = { model, plan, register, validateScene, rename, checkTransfers, requiresClient, incompatible, enforce };
