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
  function takeLatency(session, author) {
    if (!session || !author) return 0;
    // JSON dictionaries arriving in the browser have Object.prototype. Nicknames
    // such as constructor/toString must use actual entries, never inherited ones.
    const imported = session.takeLatency || {};
    const current = session.latency || {};
    const value = Object.hasOwn(imported, author) ? imported[author] : Object.hasOwn(current, author) ? current[author] : 0;
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }
  const DUCK = Object.freeze({attack:0.3,hold:0.15,release:0.85});
  const ease = x => x*x*(3-2*x);
  // Linear segments sample a smooth curve and can be safely cancelled mid-transition.
  function smoothRamp(param, from, to, start, seconds) {
    param.setValueAtTime(from,start);
    for(let i=1;i<=24;i++)param.linearRampToValueAtTime(from+(to-from)*ease(i/24),start+seconds*i/24);
  }
  function automateDucking(param, base, amount, intervals, duration) {
    const merged=[];
    for(const pair of intervals.filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0])){
      const last=merged.at(-1);
      if(last && pair[0]<=last[1]+DUCK.hold+DUCK.attack)last[1]=Math.max(last[1],pair[1]);
      else merged.push([...pair]);
    }
    const events=[[0,base]];
    const addCurve=(from,to,start,end)=>{events.push([start,from]);for(let i=1;i<=24;i++)events.push([start+(end-start)*i/24,from+(to-from)*ease(i/24)]);};
    for(const [start,end] of merged){
      const attackStart=Math.max(0,start-DUCK.attack);
      // A new phrase can interrupt an unfinished release without jumping to full volume.
      let from=base;
      for(let i=events.length-1;i>=0;i--){if(events[i][0]<=attackStart){const a=events[i],b=events[i+1];from=b && b[0]>a[0]?a[1]+(b[1]-a[1])*(attackStart-a[0])/(b[0]-a[0]):a[1];break;}}
      while(events.at(-1)?.[0]>attackStart)events.pop();
      const ducked=base*(1-amount), attackEnd=Math.min(duration,end,Math.max(start,attackStart+DUCK.attack));
      addCurve(from,ducked,attackStart,attackEnd);
      const holdEnd=Math.min(duration,end+DUCK.hold);events.push([holdEnd,ducked]);
      addCurve(ducked,base,holdEnd,Math.min(duration,holdEnd+DUCK.release));
    }
    param.setValueAtTime(base,0);
    for(const [at,value] of events)param.linearRampToValueAtTime(value,at);
  }
  const api = Object.freeze({ DUCK, smoothRamp, automateDucking, CHANNELS, MAX_VOLUME, normalize, sources, gains, sourceTime, placement, takeLatency });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DublineProjectAudio = api;
})(typeof window !== 'undefined' ? window : globalThis);
