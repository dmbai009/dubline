const crypto = require('node:crypto'), fs = require('node:fs');
const model = require('../public/take-history-model');
const { HttpError } = require('./config');
const { getLineOwner, canModerate } = require('./auth');
const revision = line => line.takeHistoryRevision || 0;
const failure = (key, status = 409) => new HttpError(status, 'Take history cannot be changed', 'takeHistory.' + key);
function normalize(line) {
  let changed = false;
  if (line.takeHistory == null) { line.takeHistory = []; changed = true; }
  if (!Number.isSafeInteger(line.takeHistoryRevision) || line.takeHistoryRevision < 0) { line.takeHistoryRevision = 0; changed = true; }
  if (line.audioUrl && !model.validId(line.takeId)) { line.takeId = crypto.randomUUID(); changed = true; }
  if (!line.audioUrl && (line.takeId || line.takePinned)) { line.takeId = null; line.takePinned = false; changed = true; }
  if (line.takePinned == null) { line.takePinned = false; changed = true; }
  return changed;
}
function check(line) {
  if (!Array.isArray(line.takeHistory) || line.takeHistory.length > model.LIMIT || line.takeHistory.some(take => !take || typeof take !== 'object')) throw failure('invalid');
  if (line.audioUrl && typeof line.takePinned !== 'boolean') throw failure('invalid');
  const ids = new Set(), urls = new Set();
  for (const take of [model.extract(line), ...line.takeHistory].filter(Boolean)) {
    if (!model.validId(take.id) || typeof take.audioUrl !== 'string' || ids.has(take.id) || urls.has(take.audioUrl) || typeof take.pinned !== 'boolean') throw failure('invalid');
    ids.add(take.id); urls.add(take.audioUrl);
  }
  if (revision(line) >= Number.MAX_SAFE_INTEGER) throw failure('invalid');
}
function requireFile(take) {
  try { const file = require('./files').diskPathForUrl(take?.audioUrl || ''); const stat = file && fs.lstatSync(file); if (!stat?.isFile() || stat.isSymbolicLink()) throw failure('missing'); }
  catch { throw failure('missing'); }
}
function allowed(room, line, nick, clientId, take = model.extract(line)) {
  const owner = getLineOwner(room, line);
  return canModerate(room, clientId) || owner === nick || !owner && !!take && take.recordedBy === nick;
}
function invalidateReservations(line) {
  const before = line.takeSequence || 0, next = Math.max(line.takeCounter || 0, before) + 1;
  if (!Number.isSafeInteger(next)) throw failure('invalid');
  line.takeInvalidatedFloor = Math.min(line.takeInvalidatedFloor ?? before, before);
  line.takeInvalidatedThrough = next; line.takeCounter = next; line.takeSequence = next;
}
function commit(room, target, line, next) {
  const previous = structuredClone(line), updatedAt = target.updatedAt, previousChecks = target.takeChecks;
  const savedSession = target === room ? room.sessions?.[room.activeSessionId] : target, sessionUpdatedAt = savedSession?.updatedAt;
  Object.assign(line, next); target.updatedAt = Date.now(); require('./sceneReview').pruneChecks(target);
  try { require('./rooms').flushRooms({ strict: true }); }
  catch (error) {
    for (const field of Object.keys(line)) delete line[field]; Object.assign(line, previous); target.updatedAt = updatedAt; target.takeChecks = previousChecks;
    if (savedSession) { savedSession.updatedAt = sessionUpdatedAt; savedSession.takeChecks = previousChecks; }
    throw failure(['ENOSPC', 'EDQUOT'].includes(error.code) ? 'diskSpace' : 'storage', ['ENOSPC', 'EDQUOT'].includes(error.code) ? 507 : 500);
  }
}
function archiveCurrent(line, now = Date.now()) {
  const current = model.extract(line); if (!current) return;
  line.takeHistory.unshift({ ...current, archivedAt: now });
}
function planUpload(line, consent = {}) {
  check(line);
  const plan = model.replacement(line);
  if (plan.kind === 'blocked') throw failure('full');
  if (plan.kind === 'confirm' && (consent.discardCurrentId !== line.takeId || Number(consent.historyRevision) !== revision(line))) throw failure('confirmOverwriteRequired');
  if (line.audioUrl) requireFile(model.extract(line));
  return plan;
}
function cleanup(urls, roomId, sessionId, lineId) {
  let failed = false;
  for (const url of urls) {
    let returned = false;
    const result = require('./files').deleteTakeFile(url, { onError: () => {
      failed = true;
      require('./log').logEvent(roomId, 'Take cleanup postponed after a disk error', 'warn');
      if (returned) require('./app').io.to(roomId).emit('take_history_warning', { sessionId, lineId, key: 'takeHistory.cleanupError' });
    } });
    if (result.error) failed = true;
    returned = true;
  }
  return failed;
}
function action(room, line, data, nick, clientId) {
  check(line);
  const current = model.extract(line), take = current?.id === data.takeId ? current : line.takeHistory.find(take => take.id === data.takeId);
  if (!take) throw failure('changed');
  if (!allowed(room, line, nick, clientId, take)) throw failure('permission', 403);
  if (data.historyRevision !== revision(line) || data.expectedOwner !== getLineOwner(room, line)) throw failure('changed');
  const next = structuredClone(line), deleted = [];
  if (data.action === 'pin') {
    if (typeof data.value !== 'boolean') throw failure('invalid', 400);
    if (take.pinned === data.value) return { next, deleted, changed: false };
    if (data.value) requireFile(take);
    if (current?.id === take.id) next.takePinned = data.value;
    else next.takeHistory.find(item => item.id === take.id).pinned = data.value;
  } else if (data.action === 'restore') {
    if (current?.id === take.id) throw failure('invalid', 400);
    requireFile(take);
    next.takeHistory = next.takeHistory.filter(item => item.id !== take.id);
    archiveCurrent(next); model.activate(next, take); invalidateReservations(next);
    next.takeMixRevision = (line.takeMixRevision || 0) + 1;
    require('./retakes').clear(next);
  } else if (data.action === 'delete') {
    if (take.pinned && data.confirmPinned !== true) throw failure('confirmDeleteRequired');
    deleted.push(take.audioUrl);
    if (current?.id === take.id) {
      const settings = structuredClone(Object.fromEntries(['effect', 'pitch', 'trimEnabled', 'volume', 'pan', 'effectAmount', 'effects', 'pitchMode', 'inheritRoleEffects', 'excludedRoleEffectIds', 'voicePresetId', 'usePresetPitch', 'presetModified'].map(key => [key, line[key] ?? model.DEFAULTS[key]])));
      Object.assign(next, require('./parsers').emptyTake(), settings, { takeId: null, takePinned: false, takeCreatedAt: null, takeDuration: null, takeUploadedSequence: 0, takeMixRevision: (line.takeMixRevision || 0) + 1 });
      invalidateReservations(next); require('./retakes').clear(next);
    } else next.takeHistory = next.takeHistory.filter(item => item.id !== take.id);
  } else throw failure('invalid', 400);
  next.takeHistoryRevision = revision(line) + 1;
  return { next, deleted, changed: true };
}
module.exports = { ...model, revision, normalize, check, failure, requireFile, allowed, invalidateReservations, commit, archiveCurrent, planUpload, action, cleanup };
