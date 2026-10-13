const model = require('../public/noise-model');
const empty = () => ({ profiles: Object.create(null), actors: Object.create(null), revision: 0 });
function state(scene) { return scene.noiseReduction || empty(); }
function binding(scene, profileId, nick) {
  if (profileId == null || profileId === '') return null;
  if (!model.id(profileId) || !Object.hasOwn(state(scene).profiles, profileId) || state(scene).profiles[profileId].author !== nick) throw Error('noise.profileMissing');
  return profileId;
}
function plan(scene, nick, data) {
  const previous = state(scene);
  if (data.revision !== previous.revision) throw Error('noise.conflict');
  if (!Number.isSafeInteger(previous.revision) || previous.revision >= Number.MAX_SAFE_INTEGER) throw Error('noise.invalid');
  const next = structuredClone(previous), patches = new Map();
  Object.setPrototypeOf(next.profiles, null); Object.setPrototypeOf(next.actors, null);
  if (data.profile !== undefined) {
    if (!model.validProfile(data.profile)) throw Error('noise.invalid');
    const p = { id: data.profile.id, version: data.profile.version, fft: data.profile.fft, sampleRate: data.profile.sampleRate,
      createdAt: data.profile.createdAt, power: [...data.profile.power], author: nick };
    if (Object.hasOwn(next.profiles, p.id) && JSON.stringify(next.profiles[p.id]) !== JSON.stringify(p)) throw Error('noise.conflict');
    next.profiles[p.id] = p;
  }
  if (data.actor !== undefined) {
    const a = data.actor;
    if (!a || typeof a.enabled !== 'boolean' || !Number.isFinite(a.strength) || a.strength < 0 || a.strength > 1 || !model.id(a.profileId) || next.profiles[a.profileId]?.author !== nick) throw Error('noise.invalid');
    next.actors[nick] = { enabled: a.enabled, strength: a.strength, profileId: a.profileId };
  }
  if (data.takes !== undefined) {
    if (!Array.isArray(data.takes) || data.takes.length > 8000 || typeof data.apply !== 'boolean') throw Error('noise.invalid');
    const seen = new Set(), lines = new Map(scene.lines.map(line => [line.id, line]));
    const profileId = data.apply ? binding({ noiseReduction: next }, data.profileId, nick) : null;
    if (data.apply && !profileId) throw Error('noise.profileMissing');
    for (const item of data.takes) {
      const line = lines.get(item?.lineId);
      if (!line || item.historyRevision !== (line.takeHistoryRevision || 0) || seen.has(item.takeId)) throw Error('noise.conflict');
      const take = line.takeId === item.takeId && line.audioUrl ? line : line.takeHistory?.find(t => t.id === item.takeId);
      // Author rights are distinct from role ownership: claiming someone else's
      // recorded line must not grant access to their microphone profile controls.
      if (!take || take.recordedBy !== nick) throw Error('noise.permission');
      seen.add(item.takeId);
      if (!patches.has(line.id)) patches.set(line.id, structuredClone(line));
      const copy = patches.get(line.id), target = copy.takeId === item.takeId ? copy : copy.takeHistory.find(t => t.id === item.takeId);
      target.noiseProfileId = profileId;
    }
    for (const line of patches.values()) line.takeHistoryRevision = (line.takeHistoryRevision || 0) + 1;
  }
  if (!model.validState(next)) throw Error(Object.keys(next.profiles).length > model.MAX_PROFILES ? 'noise.profileLimit' : 'noise.invalid');
  next.revision++;
  return { state: next, lines: [...patches.values()] };
}
function register(socket, conn) {
  require('./editorOperations').registerMutation(socket, conn, 'noise_update', (data, ack) => {
    try {
      const room = require('./rooms').getRoom(conn.roomId), previous = structuredClone(state(room));
      const result = plan(room, conn.nick, data), originals = result.lines.map(next => room.lines.find(line => line.id === next.id));
      const copies = originals.map(line => structuredClone(line)), updatedAt = room.updatedAt;
      room.noiseReduction = result.state; originals.forEach((line, i) => Object.assign(line, result.lines[i])); room.updatedAt = Date.now();
      try { require('./rooms').flushRooms({ strict: true }); }
      catch {
        room.noiseReduction = previous; room.updatedAt = updatedAt;
        originals.forEach((line, i) => { for (const key of Object.keys(line)) delete line[key]; Object.assign(line, copies[i]); });
        require('./rooms').snapshotActive(room); throw Error('noise.storage');
      }
      require('./app').io.to(conn.roomId).emit('noise_updated', { sessionId: room.activeSessionId, noiseReduction: room.noiseReduction, author: conn.nick, lines: result.lines, editorProtocol: require('./editorOperations').snapshotProtocol(room) });
      ack({ ok: true, noiseReduction: result.state });
    } catch (error) { ack({ ok: false, reason: error.message.startsWith('noise.') ? error.message : 'noise.invalid' }); }
  });
}
function rename(scene, before, after) {
  if (!scene.noiseReduction) return;
  const data = scene.noiseReduction;
  for (const profile of Object.values(data.profiles)) if (profile.author === before) profile.author = after;
  if (Object.hasOwn(data.actors, before)) { data.actors[after] = data.actors[before]; delete data.actors[before]; }
  data.revision++;
}
module.exports = { empty, state, binding, plan, register, rename };
