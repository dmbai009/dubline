(function initTakeMix(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DublineTakeMix = api;
})(typeof window === 'object' ? window : globalThis, function() {
  'use strict';
  const DEFAULTS = Object.freeze({ volume: 1, pan: 0, effectAmount: 1 });
  const RANGES = Object.freeze({ volume: [0, 3], pan: [-1, 1], effectAmount: [0, 1] });
  function valid(field, value) {
    const range = RANGES[field];
    return !!range && typeof value === 'number' && Number.isFinite(value) && value >= range[0] && value <= range[1];
  }
  function normalize(take = {}) {
    return Object.fromEntries(Object.entries(DEFAULTS).map(([field, fallback]) => [field, valid(field, take[field]) ? take[field] : fallback]));
  }
  function canEdit(take, actor, host, owner) {
    return !!actor && (!!host || (take.recordedBy ? take.recordedBy === actor : owner === actor));
  }
  return Object.freeze({ DEFAULTS, RANGES, valid, normalize, canEdit });
});
