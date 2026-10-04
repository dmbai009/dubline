// One project-audio model shared by the browser, server and offline renderer.
(function(global) {
  'use strict';
  const CHANNELS = ['original', 'backing', 'dub'];
  // Channel volume: 0..150 % (a quiet source or take can be raised in the project mix and export)
  const MAX_VOLUME = 1.5;
  const number = (value, fallback, min, max) => Number.isFinite(Number(value)) && value !== null
    ? Math.max(min, Math.min(max, Number(value))) : fallback;
  function normalize(session) {
    const raw = session.projectAudio || {};
    const result = { revision: Number.isInteger(raw.revision) ? Math.max(0, raw.revision) : 0,
      autoDuckEnabled: raw.autoDuckEnabled !== false,
      autoDuckAmount: number(raw.autoDuckAmount, 0.4, 0, 0.8) };
    for (const channel of CHANNELS) {
      const source = raw[channel] || {};
      // Legacy projects routed video audio through Background when no backing existed.
      const defaultVolume = channel === 'original' && session.backingUrl ? 0 : 1;
      result[channel] = { volume: number(source.volume, defaultVolume, 0, MAX_VOLUME), muted: source.muted === true, solo: source.solo === true };
      if (channel !== 'dub') result[channel].offset = Math.round(number(source.offset, 0, -43200, 43200) * 1000) / 1000;
    }
    return result;
  }
  function sources(session) {
    const tracks = session.audioTracks || [];
    let original = session.externalOriginalUrl || session.videoUrl || '';
    if (!session.externalOriginalUrl) {
      if (session.videoHasAudio === false) original = '';
      else if (tracks.length >= 1) original = (tracks[session.originalTrack ?? 0] || {}).url || '';
    }
    return { original, backing: session.backingUrl || '' };
  }
  function gains(mix) {
    const solo = CHANNELS.some(channel => mix[channel].solo);
    return Object.fromEntries(CHANNELS.map(channel => [channel,
      mix[channel].muted || (solo && !mix[channel].solo) ? 0 : mix[channel].volume]));
  }
  function sourceTime(timelineTime, offset) { return timelineTime - offset; }
  function placement(offset, duration) {
    const from = Math.max(0, -offset);
    return { when: Math.max(0, offset), from, duration: Math.max(0, duration - from) };
  }
  const api = Object.freeze({ CHANNELS, MAX_VOLUME, normalize, sources, gains, sourceTime, placement });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DublineProjectAudio = api;
})(typeof window !== 'undefined' ? window : globalThis);
