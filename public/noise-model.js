(function(root) {
  'use strict';
  const SCHEMA_VERSION = 2, ENGINE = 'rnnoise', ENGINE_VERSION = '2025.1.5', DSP_VERSION = 1;
  const MODEL_VERSION = '0a8755f8e2d834eff6a54714ecc7d75f9932e845df35f8b59bc52a7cfe6e8b37';
  const PROCESSING_VERSION = `${ENGINE}:${ENGINE_VERSION}:${MODEL_VERSION}:sinc64-v${DSP_VERSION}:delay960`;
  const DEFAULT = Object.freeze({ enabled: false, strength: .6 });
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const author = value => typeof value === 'string' && value.length > 0 && value.length <= 16;
  const validActor = a => object(a) && Object.keys(a).every(key => ['enabled', 'strength'].includes(key)) &&
    typeof a.enabled === 'boolean' && Number.isFinite(a.strength) && a.strength >= 0 && a.strength <= 1;
  const protocol = () => ({ schemaVersion: SCHEMA_VERSION, engine: ENGINE, engineVersion: ENGINE_VERSION, modelVersion: MODEL_VERSION, dspVersion: DSP_VERSION });
  const compatible = state => object(state) && Object.entries(protocol()).every(([key, value]) => state[key] === value);
  const empty = () => ({ ...protocol(), actors: Object.create(null), revision: 0 });
  function validState(state) {
    return compatible(state) && Object.keys(state).every(key => [...Object.keys(protocol()), 'actors', 'revision'].includes(key)) &&
      (state.revision === undefined || Number.isSafeInteger(state.revision) && state.revision >= 0) && object(state.actors) &&
      Object.keys(state.actors).length <= 2000 && Object.entries(state.actors).every(([name, a]) => author(name) && validActor(a));
  }
  function actor(state, name) { const a = Object.hasOwn(state?.actors || {}, name) && state.actors[name]; return validActor(a) ? { enabled: a.enabled, strength: a.strength } : { ...DEFAULT }; }
  function migrateState(state, authors = []) {
    const result = empty();
    if (validState(state)) {
      result.actors = Object.assign(Object.create(null), structuredClone(state.actors)); result.revision = state.revision || 0;
    } else if (state) {
      // Wiener intensity has different semantics. Never turn RNNoise on implicitly.
      const names = new Set([...Object.keys(state.actors || {}), ...Object.values(state.profiles || {}).map(p => p?.author), ...authors]);
      for (const name of names) if (author(name) && Object.keys(result.actors).length < 2000) result.actors[name] = { ...DEFAULT };
    }
    return result;
  }
  function migrateScene(scene) {
    const lines = [...(scene.lines || []), ...(scene.deletedLines || []).flatMap(batch => (batch.lines || []).map(entry => entry.line).filter(Boolean))];
    const takes = lines.flatMap(line => [line, ...(line.takeHistory || [])]);
    const next = migrateState(scene.noiseReduction, takes.map(take => take.recordedBy));
    let changed = JSON.stringify(next) !== JSON.stringify(scene.noiseReduction);
    scene.noiseReduction = next;
    for (const take of takes) if (Object.hasOwn(take, 'noiseProfileId')) { delete take.noiseProfileId; changed = true; }
    return changed;
  }
  function resolve(line, scene) {
    const state = scene?.noiseReduction;
    if (!validState(state) || !line?.recordedBy) return null;
    const a = actor(state, line.recordedBy);
    return a.enabled && a.strength > 0 ? { ...protocol(), ...a } : null;
  }
  function settingKey(setting) { return setting?.enabled && setting.strength > 0 ? `${PROCESSING_VERSION}:${setting.strength}` : 'off'; }
  const api = Object.freeze({ SCHEMA_VERSION, ENGINE, ENGINE_VERSION, DSP_VERSION, MODEL_VERSION, PROCESSING_VERSION,
    DEFAULT, author, validActor, protocol, compatible, empty, validState, actor, migrateState, migrateScene, resolve, settingKey,
    key: (line, scene) => settingKey(resolve(line, scene)) });
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineNoiseModel = api;
})(typeof window === 'undefined' ? globalThis : window);
