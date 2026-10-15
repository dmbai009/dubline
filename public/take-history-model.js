(function(root) {
  'use strict';
  const LIMIT = 3;
  const FIELDS = ['audioUrl', 'recordedBy', 'audioStart', 'recordedStart', 'trimStart', 'trimEnd',
    'trimEnabled', 'effect', 'pitch', 'effectAmount', 'volume', 'pan', 'blindRevealed',
    'effects', 'pitchMode', 'inheritRoleEffects', 'excludedRoleEffectIds', 'voicePresetId', 'usePresetPitch'];
  const DEFAULTS = { audioUrl: null, recordedBy: null, audioStart: null, recordedStart: null,
    trimStart: null, trimEnd: null, trimEnabled: true, effect: 'none', pitch: 0,
    effectAmount: 1, volume: 1, pan: 0, blindRevealed: false,
    effects: null, pitchMode: null, inheritRoleEffects: true, excludedRoleEffectIds: [], voicePresetId: null, usePresetPitch: false };
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
  const nullable = (value, max = 86400) => Number.isFinite(value) && value >= 0 && value <= max ? value : null;
  function extract(line) {
    if (!line?.audioUrl) return null;
    return { ...structuredClone(Object.fromEntries(FIELDS.map(field => [field, line[field] ?? DEFAULTS[field]]))),
      id: line.takeId, pinned: line.takePinned === true, createdAt: nullable(line.takeCreatedAt, 8640000000000000),
      duration: nullable(line.takeDuration), uploadId: line.uploadId || null, uploadSequence: line.takeUploadedSequence ?? line.takeSequence ?? 0 };
  }
  function activate(line, take) {
    for (const field of FIELDS) line[field] = structuredClone(take[field] ?? DEFAULTS[field]);
    line.takeId = take.id; line.takePinned = take.pinned === true;
    line.takeCreatedAt = take.createdAt ?? null; line.takeDuration = take.duration ?? null;
    line.uploadId = take.uploadId || null; line.takeUploadedSequence = take.uploadSequence || 0;
  }
  function replacement(line) {
    if (!line.audioUrl || (line.takeHistory || []).length < LIMIT) return { kind: 'keep', evict: null };
    const history = line.takeHistory || [];
    for (let index = history.length - 1; index >= 0; index--) if (!history[index].pinned) return { kind: 'keep', evict: history[index].id };
    return { kind: line.takePinned ? 'blocked' : 'confirm', evict: null };
  }
  const api = Object.freeze({ LIMIT, FIELDS, DEFAULTS, validId, extract, activate, replacement });
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineTakeHistoryModel = api;
})(typeof window === 'undefined' ? globalThis : window);
