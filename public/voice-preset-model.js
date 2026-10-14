(function(root) {
  'use strict';
  const chain = typeof module !== 'undefined' && module.exports ? require('./voice-chain-model') : root.DublineVoiceChain;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const MAX_PRESETS = 50, MAX_NAME = 80;
  const name = value => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_NAME && !/[\x00-\x1f\x7f]/.test(value);
  function validSettings(value) {
    return object(value) && Object.keys(value).every(key => ['effects', 'pitch'].includes(key)) && chain.validEffects(value.effects) &&
      (value.pitch === undefined || typeof value.pitch === 'number' && Number.isFinite(value.pitch) && Math.abs(value.pitch) <= 12) && chain.safe({ effects: value.effects, pitch: value.pitch ?? 0 });
  }
  function validEntry(value, id = value?.id) {
    return object(value) && Object.keys(value).every(key => ['id', 'name', 'effects', 'pitch', 'createdBy', 'revision'].includes(key)) && chain.id(id) && value.id === id && name(value.name) &&
      typeof value.createdBy === 'string' && value.createdBy.length > 0 && value.createdBy.length <= 16 && !/[\x00-\x1f\x7f]/.test(value.createdBy) && Number.isSafeInteger(value.revision) && value.revision >= 1 &&
      validSettings({ effects: value.effects, ...(value.pitch === undefined ? {} : { pitch: value.pitch }) });
  }
  const validLibrary = value => object(value) && Object.keys(value).length <= MAX_PRESETS && Object.entries(value).every(([id, entry]) => validEntry(entry, id));
  function apply(take, scene, preset, { append = false, pitch = false, newId } = {}) {
    if (!validEntry(preset) || typeof newId !== 'function') throw Error('preset.invalid');
    const settings = chain.take(take), copied = preset.effects.map(effect => ({ ...structuredClone(effect), id: newId() }));
    settings.effects = append ? [...settings.effects, ...copied] : copied;
    const next = { ...take, ...settings };
    if (pitch && preset.pitch !== undefined) { next.pitch = preset.pitch; next.pitchMode = 'override'; }
    if (!chain.validTake(chain.take(next)) || !chain.safe(chain.resolve(next, scene))) throw Error('fx.limit');
    return next;
  }
  const api = { MAX_PRESETS, MAX_NAME, name, validSettings, validEntry, validLibrary, apply };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineVoicePresets = api;
})(typeof window === 'undefined' ? globalThis : window);
