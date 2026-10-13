(function(root) {
  'use strict';
  const VERSION = 1, FFT = 1024, BINS = FFT / 2 + 1, MAX_PROFILES = 64;
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  function validProfile(p) {
    return object(p) && id(p.id) && p.version === VERSION && p.fft === FFT &&
      Number.isInteger(p.sampleRate) && p.sampleRate >= 8000 && p.sampleRate <= 192000 &&
      Number.isFinite(p.createdAt) && p.createdAt >= 0 &&
      Array.isArray(p.power) && p.power.length === BINS && p.power.every(n => Number.isFinite(n) && n >= 0 && n <= 1e6);
  }
  function validState(state) {
    if (!object(state) || !object(state.profiles) || !object(state.actors) || Object.keys(state.profiles).length > MAX_PROFILES || Object.keys(state.actors).length > 2000) return false;
    for (const [key, p] of Object.entries(state.profiles)) if (key !== p.id || !validProfile(p) || typeof p.author !== 'string' || !p.author.length || p.author.length > 16) return false;
    for (const [name, actor] of Object.entries(state.actors)) if (!name.length || name.length > 16 || !object(actor) || typeof actor.enabled !== 'boolean' || !Number.isFinite(actor.strength) || actor.strength < 0 || actor.strength > 1 || !id(actor.profileId) || state.profiles[actor.profileId]?.author !== name) return false;
    return true;
  }
  function resolve(line, scene) {
    const state = scene?.noiseReduction, p = state?.profiles?.[line.noiseProfileId], actor = state?.actors?.[line.recordedBy];
    if (!line.noiseProfileId || !actor?.enabled || !actor.strength) return null;
    return validProfile(p) && p.author === line.recordedBy ? { profile: p, strength: actor.strength } : { missing: true };
  }
  function key(line, scene) {
    const setting = resolve(line, scene);
    return setting ? `${line.noiseProfileId}:${setting.profile?.version || 'missing'}:${setting.strength ?? 0}` : 'off';
  }
  const api = { VERSION, FFT, BINS, MAX_PROFILES, id, validProfile, validState, resolve, key };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineNoiseModel = api;
})(typeof window === 'undefined' ? globalThis : window);
