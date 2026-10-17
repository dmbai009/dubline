(function(root) {
  'use strict';
  const chain = typeof module !== 'undefined' && module.exports ? require('./voice-chain-model') : root.DublineVoiceChain;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const MAX_PRESETS = 50, MAX_NAME = 80;
  const ICONS = Object.freeze({ voice: '◉', sparkles: '✦', robot: '🤖', radio: '📻', telephone: '☎', monster: '👹', thoughts: '💭', cave: '◈', behindDoor: '🚪', megaphone: '📣', echo: '≋', music: '♫' });
  const validIcon = value => typeof value === 'string' && Object.hasOwn(ICONS, value);
  const icon = preset => ICONS[preset?.icon] || ICONS.voice;
  const roleNamed = (scene, name) => (scene?.trackOrder || scene?.roles || []).includes(name) ? name : null;
  const rolePreset = (scene, name) => { const linked = chain.preset(scene, chain.role(scene, name)); return linked?.role === name ? linked : Object.values(scene?.voicePresets || {}).find(preset => preset.role === name) || null; };
  const canEditRole = (scene, name, actor, moderator) => !!actor && !!roleNamed(scene, name) && (!!moderator || scene?.singlePlayer === true || Object.hasOwn(scene?.characterClaims || {}, name) && scene.characterClaims[name] === actor);
  function canEditPreset(scene, preset, actor, moderator, action = 'update') {
    if (!preset || !actor) return false;
    const role = preset.role;
    if (role && !canEditRole(scene, role, actor, moderator)) return false;
    return !!moderator || preset.createdBy === actor || action === 'update' && !!role && canEditRole(scene, role, actor, moderator);
  }
  function roleTarget(scene, character) { const entry = chain.role(scene, character); return { character, revision: entry.revision || 0, voicePresetId: entry.voicePresetId || null }; }
  const name = value => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_NAME && !/[\x00-\x1f\x7f]/.test(value);
  function validSettings(value) {
    return object(value) && Object.keys(value).every(key => ['effects', 'pitch'].includes(key)) && chain.validEffects(value.effects, 16) &&
      (value.pitch === undefined || typeof value.pitch === 'number' && Number.isFinite(value.pitch) && Math.abs(value.pitch) <= 12) && chain.safe({ effects: value.effects, pitch: value.pitch ?? 0 });
  }
  function validEntry(value, id = value?.id) {
    return object(value) && Object.keys(value).every(key => ['id', 'name', 'effects', 'pitch', 'createdBy', 'revision', 'icon', 'role'].includes(key)) && chain.id(id) && value.id === id && name(value.name) && (value.role === undefined || name(value.role) && value.role.length <= 40) && (value.icon === undefined || validIcon(value.icon)) &&
      typeof value.createdBy === 'string' && value.createdBy.length > 0 && value.createdBy.length <= 16 && !/[\x00-\x1f\x7f]/.test(value.createdBy) && Number.isSafeInteger(value.revision) && value.revision >= 1 &&
      validSettings({ effects: value.effects, ...(value.pitch === undefined ? {} : { pitch: value.pitch }) });
  }
  const validLibrary = value => object(value) && Object.keys(value).length <= MAX_PRESETS && Object.entries(value).every(([id, entry]) => validEntry(entry, id));
  function apply(take, scene, preset, { append = false, pitch = false, newId } = {}) {
    if (!validEntry(preset) || preset.role || typeof newId !== 'function') throw Error('preset.invalid');
    const base = typeof take.presetModified === 'boolean' ? chain.modify(take, scene) : take;
    const settings = chain.take(base), copied = preset.effects.map(effect => ({ ...structuredClone(effect), id: newId() }));
    settings.effects = append ? [...settings.effects, ...copied] : copied;
    const next = { ...base, ...settings, ...(append ? {} : { voicePresetId: null, usePresetPitch: false }) };
    if (pitch && preset.pitch !== undefined) { next.pitch = preset.pitch; next.pitchMode = 'override'; }
    if (!chain.validTake(chain.take(next)) || !chain.safe(chain.resolve(next, scene))) throw Error('fx.limit');
    return next;
  }
  function link(take, scene, selected, usePitch = false) {
    const value = scene?.voicePresets?.[selected]; if (!validEntry(value, selected) || value.role || typeof usePitch !== 'boolean') throw Error('preset.invalid');
    const next = { ...take, ...chain.take(take), effects: [], voicePresetId: selected, usePresetPitch: usePitch, presetModified: false };
    if (usePitch) { next.pitch = 0; next.pitchMode = 'override'; }
    if (!chain.safe(chain.resolve(next, scene))) throw Error('fx.limit'); return next;
  }
  function detach(take, scene, newId) {
    const own = chain.take(take), linked = chain.preset(scene, own), next = { ...take, ...own, voicePresetId: null, usePresetPitch: false, presetModified: true };
    next.effects = chain.ownEffects(own, scene).map(effect => ({ ...structuredClone(effect), id: newId() }));
    if (own.presetModified !== true && own.usePresetPitch && linked?.pitch !== undefined) { next.pitch = linked.pitch; next.pitchMode = 'override'; }
    if (!chain.validTake(chain.take(next)) || !chain.safe(chain.resolve(next, scene))) throw Error('fx.limit'); return next;
  }
  function usage(scene, id) {
    const roles = Object.entries(scene?.roleEffects || {}).filter(([, entry]) => entry.voicePresetId === id && entry.presetModified !== true).map(([name]) => name);
    const lines = (scene?.lines || []).filter(line => [line, ...(line.takeHistory || [])].some(take => take.voicePresetId === id && take.presetModified !== true || roles.includes(line.character) && (take.inheritRoleEffects !== false || chain.take(take).pitchMode === 'inherit' && chain.role(scene, line.character).usePresetPitch === true)));
    return { roles, lines: lines.map(line => line.id), variants: (scene?.lines || []).reduce((sum, line) => sum + [line, ...(line.takeHistory || [])].filter(take => take.voicePresetId === id && take.presetModified !== true).length, 0) };
  }
  // Names are presentation; role ownership is an explicit binding. Existing take
  // links to a former role preset become exact private snapshots before updates.
  function migrateScene(scene) {
    let changed = false;
    const scopes = [{ roles: scene?.roleEffects || {}, lines: scene?.lines || [] }, ...(scene?.deletedLines || []).map(batch => ({ roles: batch.roleEffects || {}, lines: (batch.lines || []).map(entry => entry.line).filter(Boolean) }))];
    for (const scope of scopes) for (const [character, entry] of Object.entries(scope.roles)) {
      const preset = chain.preset(scene, entry);
      if (preset && preset.role === undefined && preset.name === character) { preset.role = character; changed = true; }
    }
    for (const scope of scopes) for (const [character, entry] of Object.entries(scope.roles)) {
      const preset = chain.preset(scene, entry);
      if (preset && preset.role !== character) {
        const effects = structuredClone(chain.ownEffects(entry, scene)), pitch = chain.ownPitch(entry, scene);
        Object.assign(entry, { effects, pitch, voicePresetId: null, usePresetPitch: false, presetModified: true }); changed = true;
      }
    }
    for (const scope of scopes) for (const line of scope.lines) for (const entry of [line, ...(line.takeHistory || [])]) {
      const preset = chain.preset(scene, entry);
      if (!preset?.role) continue;
      const effects = structuredClone(chain.ownEffects(entry, scene)), pitch = chain.ownPitch(entry, scene), presetPitch = entry.presetModified !== true && entry.usePresetPitch && preset.pitch !== undefined;
      Object.assign(entry, { effects, voicePresetId: null, usePresetPitch: false, presetModified: true });
      if (pitch !== undefined) entry.pitch = pitch;
      // A preset pitch was an override, whereas ordinary inherited pitch stays inherited.
      if (presetPitch) entry.pitchMode = 'override';
      changed = true;
    }
    return reconcileNames(scene) || changed;
  }
  function reconcileNames(scene) {
    const catalog = scene?.voicePresets || {}, names = new Set(scene?.trackOrder || []); let changed = false;
    for (const [character, entry] of Object.entries(scene?.roleEffects || {})) {
      const preset = chain.preset(scene, entry);
      if (preset?.role && (preset.role !== character || preset.name !== character)) { preset.role = character; preset.name = character; preset.revision++; changed = true; }
    }
    for (const preset of Object.values(catalog)) {
      if (preset.role || !names.has(preset.name)) continue;
      const base = preset.name.slice(0, MAX_NAME - 20); let suffix = 1, candidate;
      do { candidate = base + ' (preset' + (suffix === 1 ? '' : ' ' + suffix) + ')'; suffix++; } while (names.has(candidate) || Object.values(catalog).some(other => other.id !== preset.id && other.name === candidate));
      preset.name = candidate; preset.revision++; changed = true;
    }
    return changed;
  }
  const api = { MAX_PRESETS, MAX_NAME, ICONS, validIcon, icon, roleNamed, rolePreset, roleTarget, canEditRole, canEditPreset, name, validSettings, validEntry, validLibrary, apply, link, detach, usage, migrateScene, reconcileNames };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineVoicePresets = api;
})(typeof window === 'undefined' ? globalThis : window);
