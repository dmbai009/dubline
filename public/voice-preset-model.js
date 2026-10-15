(function(root) {
  'use strict';
  const chain = typeof module !== 'undefined' && module.exports ? require('./voice-chain-model') : root.DublineVoiceChain;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const MAX_PRESETS = 50, MAX_NAME = 80;
  const ICONS = Object.freeze({ voice: '◉', sparkles: '✦', robot: '🤖', radio: '📻', telephone: '☎', monster: '👹', thoughts: '💭', cave: '◈', behindDoor: '🚪', megaphone: '📣', echo: '≋', music: '♫' });
  const validIcon = value => typeof value === 'string' && Object.hasOwn(ICONS, value);
  const icon = preset => ICONS[preset?.icon] || ICONS.voice;
  const name = value => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_NAME && !/[\x00-\x1f\x7f]/.test(value);
  function validSettings(value) {
    return object(value) && Object.keys(value).every(key => ['effects', 'pitch'].includes(key)) && chain.validEffects(value.effects) &&
      (value.pitch === undefined || typeof value.pitch === 'number' && Number.isFinite(value.pitch) && Math.abs(value.pitch) <= 12) && chain.safe({ effects: value.effects, pitch: value.pitch ?? 0 });
  }
  function validEntry(value, id = value?.id) {
    return object(value) && Object.keys(value).every(key => ['id', 'name', 'effects', 'pitch', 'createdBy', 'revision', 'icon'].includes(key)) && chain.id(id) && value.id === id && name(value.name) && (value.icon === undefined || validIcon(value.icon)) &&
      typeof value.createdBy === 'string' && value.createdBy.length > 0 && value.createdBy.length <= 16 && !/[\x00-\x1f\x7f]/.test(value.createdBy) && Number.isSafeInteger(value.revision) && value.revision >= 1 &&
      validSettings({ effects: value.effects, ...(value.pitch === undefined ? {} : { pitch: value.pitch }) });
  }
  const validLibrary = value => object(value) && Object.keys(value).length <= MAX_PRESETS && Object.entries(value).every(([id, entry]) => validEntry(entry, id));
  function apply(take, scene, preset, { append = false, pitch = false, newId } = {}) {
    if (!validEntry(preset) || typeof newId !== 'function') throw Error('preset.invalid');
    const settings = chain.take(take), copied = preset.effects.map(effect => ({ ...structuredClone(effect), id: newId() }));
    settings.effects = append ? [...settings.effects, ...copied] : copied;
    const next = { ...take, ...settings, ...(append ? {} : { voicePresetId: null, usePresetPitch: false }) };
    if (pitch && preset.pitch !== undefined) { next.pitch = preset.pitch; next.pitchMode = 'override'; }
    if (!chain.validTake(chain.take(next)) || !chain.safe(chain.resolve(next, scene))) throw Error('fx.limit');
    return next;
  }
  function link(take, scene, selected, usePitch = false) {
    const value = scene?.voicePresets?.[selected]; if (!validEntry(value, selected) || typeof usePitch !== 'boolean') throw Error('preset.invalid');
    const next = { ...take, ...chain.take(take), effects: [], voicePresetId: selected, usePresetPitch: usePitch };
    if (!chain.safe(chain.resolve(next, scene))) throw Error('fx.limit'); return next;
  }
  function detach(take, scene, newId) {
    const own = chain.take(take), linked = chain.preset(scene, own), next = { ...take, ...own, voicePresetId: null, usePresetPitch: false };
    next.effects = [...(linked?.effects || []), ...own.effects].map(effect => ({ ...structuredClone(effect), id: newId() }));
    if (own.usePresetPitch && linked?.pitch !== undefined) { next.pitch = linked.pitch; next.pitchMode = 'override'; }
    if (!chain.validTake(chain.take(next)) || !chain.safe(chain.resolve(next, scene))) throw Error('fx.limit'); return next;
  }
  function usage(scene, id) {
    const roles = Object.entries(scene?.roleEffects || {}).filter(([, entry]) => entry.voicePresetId === id).map(([name]) => name);
    const lines = (scene?.lines || []).filter(line => [line, ...(line.takeHistory || [])].some(take => take.voicePresetId === id || roles.includes(line.character) && (take.inheritRoleEffects !== false || chain.take(take).pitchMode === 'inherit' && chain.role(scene, line.character).usePresetPitch === true)));
    return { roles, lines: lines.map(line => line.id), variants: (scene?.lines || []).reduce((sum, line) => sum + [line, ...(line.takeHistory || [])].filter(take => take.voicePresetId === id).length, 0) };
  }
  const api = { MAX_PRESETS, MAX_NAME, ICONS, validIcon, icon, name, validSettings, validEntry, validLibrary, apply, link, detach, usage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineVoicePresets = api;
})(typeof window === 'undefined' ? globalThis : window);
