// Read-only format 7/8 validation. No legacy DSP or runtime profile assignment.
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
function validProfile(p) {
  return object(p) && id(p.id) && p.version === 1 && p.fft === 1024 &&
    Number.isInteger(p.sampleRate) && p.sampleRate >= 8000 && p.sampleRate <= 192000 &&
    Number.isFinite(p.createdAt) && p.createdAt >= 0 && Array.isArray(p.power) &&
    p.power.length === 513 && p.power.every(n => Number.isFinite(n) && n >= 0 && n <= 1e6);
}
function validState(state) {
  if (!object(state) || !object(state.profiles) || !object(state.actors) ||
      Object.keys(state.profiles).length > 64 || Object.keys(state.actors).length > 2000) return false;
  return Object.entries(state.profiles).every(([key, p]) => key === p.id && validProfile(p) && typeof p.author === 'string' && p.author.length > 0 && p.author.length <= 16) &&
    Object.entries(state.actors).every(([name, a]) => name.length > 0 && name.length <= 16 && object(a) && typeof a.enabled === 'boolean' &&
      Number.isFinite(a.strength) && a.strength >= 0 && a.strength <= 1 && id(a.profileId) && Object.hasOwn(state.profiles, a.profileId) && state.profiles[a.profileId].author === name);
}
module.exports = { id, validProfile, validState };
