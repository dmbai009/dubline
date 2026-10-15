(function(root) {
  'use strict';
  const TYPES = ['robot', 'radio', 'telephone', 'monster', 'thoughts', 'cave', 'behindDoor', 'megaphone', 'echo'];
  const MAX_EFFECTS = 8, MAX_HEAVY = 4, MAX_TAIL = 12;
  const FIELDS = ['effects', 'pitchMode', 'inheritRoleEffects', 'excludedRoleEffectIds', 'voicePresetId', 'usePresetPitch', 'presetModified'];
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const finite = (value, low, high) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
  const echo = parameters => ({ delay: parameters?.delay ?? .22, feedback: parameters?.feedback ?? .35 });
  function validEffects(value, maximum = MAX_EFFECTS) {
    if (!Array.isArray(value) || value.length > maximum) return false;
    const ids = new Set();
    return value.every(item => {
      if (!object(item) || !id(item.id) || ids.has(item.id) || !TYPES.includes(item.type) || typeof item.enabled !== 'boolean' || !finite(item.amount, 0, 1) || !object(item.parameters) || Object.keys(item).some(key => !['id', 'type', 'enabled', 'amount', 'parameters'].includes(key))) return false;
      ids.add(item.id);
      return item.type === 'echo' ? Object.keys(item.parameters).every(key => ['delay', 'feedback'].includes(key)) && finite(echo(item.parameters).delay, .03, .8) && finite(echo(item.parameters).feedback, 0, .7) : Object.keys(item.parameters).length === 0;
    });
  }
  function take(take = {}) {
    return { effects: Array.isArray(take.effects) ? structuredClone(take.effects) : take.effect && take.effect !== 'none' ? [{ id: 'legacy', type: take.effect, enabled: true, amount: take.effectAmount ?? 1, parameters: {} }] : [],
      pitchMode: take.pitchMode || (Object.hasOwn(take, 'pitch') ? 'override' : 'inherit'),
      inheritRoleEffects: take.inheritRoleEffects !== false, excludedRoleEffectIds: [...(take.excludedRoleEffectIds || [])], voicePresetId: take.voicePresetId ?? null, usePresetPitch: take.usePresetPitch ?? false, ...(typeof take.presetModified === 'boolean' ? { presetModified: take.presetModified } : {}) };
  }
  function validTake(value) {
    return object(value) && Object.keys(value).every(key => FIELDS.includes(key)) && validEffects(value.effects, value.presetModified === true ? 16 : MAX_EFFECTS) && (value.presetModified === undefined || typeof value.presetModified === 'boolean' && (value.presetModified || !value.effects.length)) && (value.voicePresetId == null || id(value.voicePresetId)) && (value.usePresetPitch === undefined || typeof value.usePresetPitch === 'boolean') && ['inherit', 'override'].includes(value.pitchMode) && typeof value.inheritRoleEffects === 'boolean' && Array.isArray(value.excludedRoleEffectIds) && value.excludedRoleEffectIds.length <= (typeof value.presetModified === 'boolean' ? 16 : MAX_EFFECTS) && value.excludedRoleEffectIds.every(id) && new Set(value.excludedRoleEffectIds).size === value.excludedRoleEffectIds.length;
  }
  const role = (scene, name) => Object.hasOwn(scene?.roleEffects || {}, name) ? scene.roleEffects[name] : { pitch: 0, effects: [], revision: 0 };
  const preset = (scene, entry) => entry?.voicePresetId && Object.hasOwn(scene?.voicePresets || {}, entry.voicePresetId) ? scene.voicePresets[entry.voicePresetId] : null;
  // Undefined marks legacy overlays. New entries always select one own chain.
  function ownEffects(entry, scene) { const linked = preset(scene, entry); return entry.presetModified === true ? entry.effects || [] : entry.presetModified === false ? linked?.effects || entry.effects || [] : [...(linked?.effects || []), ...(entry.effects || [])]; }
  function ownPitch(entry, scene) { const linked = preset(scene, entry); return entry.presetModified !== true && entry.usePresetPitch && linked?.pitch !== undefined ? linked.pitch : entry.pitch; }
  function editable(entry, scene) {
    const next = { ...structuredClone(entry), ...take(entry) }, linked = preset(scene, entry);
    if (typeof entry.presetModified !== 'boolean') {
      next.presetModified = !!(linked && next.effects.length);
      if (next.presetModified) { next.effects = structuredClone(ownEffects(entry, scene)); const reserved = new Set(next.effects.map(item => item.id)), seen = new Set(); next.effects.forEach((item, i) => { if (seen.has(item.id)) { let suffix = 0; while (reserved.has('snapshot-' + i + '-' + suffix)) suffix++; item.id = 'snapshot-' + i + '-' + suffix; reserved.add(item.id); } seen.add(item.id); }); if (entry.usePresetPitch && linked.pitch !== undefined) { next.pitch = linked.pitch; next.pitchMode = 'override'; } next.usePresetPitch = false; }
      else if (!linked) next.presetModified = true;
    }
    return next;
  }
  function modify(entry, scene) { const next = editable(entry, scene); if (next.presetModified === false) { next.effects = structuredClone(ownEffects(next, scene)); if (next.usePresetPitch && preset(scene, next)?.pitch !== undefined) { next.pitch = ownPitch(next, scene); next.pitchMode = 'override'; } next.usePresetPitch = false; next.presetModified = true; } return next; }
  // Read-time upgrade of the former preset + extras overlay. No media or mix is changed.
  // Pure legacy role-only chains remain a compatibility role definition until explicitly saved.
  function migrateScene(scene) {
    if (!scene || !Array.isArray(scene.lines)) return false;
    let changed = false;
    const scopes = [{ roles: scene.roleEffects || {}, lines: scene.lines }, ...(scene.deletedLines || []).map(batch => ({ roles: batch.roleEffects || {}, lines: (batch.lines || []).map(entry => entry.line).filter(Boolean) }))];
    const maps = new Map();
    for (const scope of scopes) for (const [name, entry] of Object.entries(scope.roles)) {
      if (!entry || typeof entry.presetModified === 'boolean' || !preset(scene, entry) || !entry.effects?.length) continue;
      const before = ownEffects(entry, scene), next = editable(entry, scene), ids = new Map();
      before.forEach((item, i) => ids.set(item.id, [...(ids.get(item.id) || []), next.effects[i].id]));
      Object.assign(entry, { effects: next.effects, pitch: next.pitch, voicePresetId: next.voicePresetId, usePresetPitch: next.usePresetPitch, presetModified: true }); maps.set(entry, ids); changed = true;
    }
    for (const scope of scopes) for (const line of scope.lines) for (const entry of [line, ...(line.takeHistory || [])]) {
      if (typeof entry.presetModified !== 'boolean' && preset(scene, entry) && entry.effects?.length) {
        const next = editable(entry, scene); Object.assign(entry, take(next)); if (next.pitch !== undefined) entry.pitch = next.pitch; changed = true;
      }
      const roleEntry = Object.hasOwn(scope.roles, line.character) ? scope.roles[line.character] : role(scene, line.character), ids = maps.get(roleEntry);
      if (ids && entry.excludedRoleEffectIds?.length) { entry.excludedRoleEffectIds = [...new Set(entry.excludedRoleEffectIds.flatMap(id => ids.get(id) || [id]))]; if (typeof entry.presetModified !== 'boolean') entry.presetModified = entry.voicePresetId ? false : true; changed = true; }
    }
    return changed;
  }
  function roleVoice(scene, name) { const entry = role(scene, name); return { ...entry, effects: ownEffects(entry, scene), pitch: ownPitch(entry, scene) }; }
  function references(value, scene) { return !value.voicePresetId || !!preset(scene, value); }
  const active = items => items.filter(item => item.enabled && item.amount > 0);
  function tail(item) {
    if (!item.enabled || !item.amount) return 0;
    if (item.type === 'echo') { const p = echo(item.parameters); return p.delay * (p.feedback ? Math.ceil(Math.log(.001) / Math.log(p.feedback)) : 1); }
    return ({ robot: .12, radio: .08, telephone: .08, monster: .05, thoughts: .7, cave: 2, behindDoor: .06, megaphone: .15 })[item.type] || 0;
  }
  function resolve(line, scene) {
    if (Object.hasOwn(line, '_exportVoice')) return structuredClone(line._exportVoice);
    const own = take(line), shared = roleVoice(scene, line.character), linked = preset(scene, own);
    const inherited = own.inheritRoleEffects ? shared.effects.filter(item => !own.excludedRoleEffectIds.includes(item.id)) : [];
    const effects = [...inherited, ...ownEffects(own, scene)];
    return { pitch: own.presetModified !== true && own.usePresetPitch && linked?.pitch !== undefined ? linked.pitch : own.pitchMode === 'inherit' ? shared.pitch : line.pitch || 0, effects, tail: effects.reduce((sum, item) => sum + tail(item), 0) };
  }
  function safe(config) {
    const enabled = active(config.effects);
    return Array.isArray(config.effects) && config.effects.every(item => validEffects([item])) && finite(config.pitch, -12, 12) && enabled.length <= MAX_EFFECTS && enabled.filter(item => ['monster', 'cave', 'thoughts'].includes(item.type)).length <= MAX_HEAVY && enabled.reduce((sum, item) => sum + tail(item), 0) <= MAX_TAIL;
  }
  function validRoles(roles, names) {
    return object(roles) && Object.keys(roles).length <= 2000 && Object.entries(roles).every(([name, entry]) => names.includes(name) && object(entry) && Object.keys(entry).every(key => ['pitch', 'effects', 'revision', 'voicePresetId', 'usePresetPitch', 'presetModified'].includes(key)) && (entry.revision === undefined || Number.isSafeInteger(entry.revision) && entry.revision >= 0) && (entry.voicePresetId == null || id(entry.voicePresetId)) && (entry.usePresetPitch === undefined || typeof entry.usePresetPitch === 'boolean') && finite(entry.pitch, -12, 12) && validEffects(entry.effects, entry.presetModified === true ? 16 : MAX_EFFECTS) && (entry.presetModified === undefined || typeof entry.presetModified === 'boolean' && (entry.presetModified || !entry.effects.length)) && safe({ pitch: entry.pitch, effects: entry.effects }));
  }
  const key = config => JSON.stringify({ pitch: config.pitch, effects: active(config.effects).map(({ type, amount, parameters }) => ({ type, amount, parameters })) });
  const api = { TYPES, MAX_EFFECTS, MAX_HEAVY, MAX_TAIL, FIELDS, id, echo, validEffects, take, validTake, role, roleVoice, ownEffects, ownPitch, editable, modify, migrateScene, preset, references, active, tail, resolve, safe, validRoles, key };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineVoiceChain = api;
})(typeof window === 'undefined' ? globalThis : window);
