(function(root) {
  'use strict';
  const TYPES = ['robot', 'radio', 'telephone', 'monster', 'thoughts', 'cave', 'behindDoor', 'megaphone', 'echo'];
  const MAX_EFFECTS = 8, MAX_HEAVY = 4, MAX_TAIL = 12;
  const FIELDS = ['effects', 'pitchMode', 'inheritRoleEffects', 'excludedRoleEffectIds'];
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const finite = (value, low, high) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
  const echo = parameters => ({ delay: parameters?.delay ?? .22, feedback: parameters?.feedback ?? .35 });
  function validEffects(value) {
    if (!Array.isArray(value) || value.length > MAX_EFFECTS) return false;
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
      inheritRoleEffects: take.inheritRoleEffects !== false, excludedRoleEffectIds: [...(take.excludedRoleEffectIds || [])] };
  }
  function validTake(value) {
    return object(value) && Object.keys(value).every(key => FIELDS.includes(key)) && validEffects(value.effects) && ['inherit', 'override'].includes(value.pitchMode) && typeof value.inheritRoleEffects === 'boolean' && Array.isArray(value.excludedRoleEffectIds) && value.excludedRoleEffectIds.length <= MAX_EFFECTS && value.excludedRoleEffectIds.every(id) && new Set(value.excludedRoleEffectIds).size === value.excludedRoleEffectIds.length;
  }
  const role = (scene, name) => Object.hasOwn(scene?.roleEffects || {}, name) ? scene.roleEffects[name] : { pitch: 0, effects: [], revision: 0 };
  const active = items => items.filter(item => item.enabled && item.amount > 0);
  function tail(item) {
    if (!item.enabled || !item.amount) return 0;
    if (item.type === 'echo') { const p = echo(item.parameters); return p.delay * (p.feedback ? Math.ceil(Math.log(.001) / Math.log(p.feedback)) : 1); }
    return ({ robot: .12, radio: .08, telephone: .08, monster: .05, thoughts: .7, cave: 2, behindDoor: .06, megaphone: .15 })[item.type] || 0;
  }
  function resolve(line, scene) {
    if (Object.hasOwn(line, '_exportVoice')) return structuredClone(line._exportVoice);
    const own = take(line), shared = role(scene, line.character);
    const inherited = own.inheritRoleEffects ? shared.effects.filter(item => !own.excludedRoleEffectIds.includes(item.id)) : [];
    const effects = [...inherited, ...own.effects];
    return { pitch: own.pitchMode === 'inherit' ? shared.pitch : line.pitch || 0, effects, tail: effects.reduce((sum, item) => sum + tail(item), 0) };
  }
  function safe(config) {
    const enabled = active(config.effects);
    return Array.isArray(config.effects) && config.effects.every(item => validEffects([item])) && finite(config.pitch, -12, 12) && enabled.length <= MAX_EFFECTS && enabled.filter(item => ['monster', 'cave', 'thoughts'].includes(item.type)).length <= MAX_HEAVY && enabled.reduce((sum, item) => sum + tail(item), 0) <= MAX_TAIL;
  }
  function validRoles(roles, names) {
    return object(roles) && Object.keys(roles).length <= 2000 && Object.entries(roles).every(([name, entry]) => names.includes(name) && object(entry) && Object.keys(entry).every(key => ['pitch', 'effects', 'revision'].includes(key)) && (entry.revision === undefined || Number.isSafeInteger(entry.revision) && entry.revision >= 0) && finite(entry.pitch, -12, 12) && validEffects(entry.effects) && safe({ pitch: entry.pitch, effects: entry.effects }));
  }
  const key = config => JSON.stringify({ pitch: config.pitch, effects: active(config.effects).map(({ type, amount, parameters }) => ({ type, amount, parameters })) });
  const api = { TYPES, MAX_EFFECTS, MAX_HEAVY, MAX_TAIL, FIELDS, id, echo, validEffects, take, validTake, role, active, tail, resolve, safe, validRoles, key };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DublineVoiceChain = api;
})(typeof window === 'undefined' ? globalThis : window);
