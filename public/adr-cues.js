(function(global) {
  'use strict';
  function preparation(seconds, enabled) { return Math.max(enabled ? 3 : 0, Math.min(5, Number(seconds) || 0)); }
  function create(AudioContext, volume = () => 1) {
    let context = null, masterGain = null, generation = 0;
    function updateMaster() { if (masterGain) masterGain.gain.setValueAtTime(global.DublineState?.data.volumes.isMuted ? 0 : (global.localMasterVolume?.() ?? 1), context.currentTime); }
    global.addEventListener?.('dubline-listening-volume-changed', updateMaster);
    const nodes = new Set();
    function stop() {
      generation++;
      for (const node of nodes) { try { node.stop(); } catch { /* already ended */ } }
      nodes.clear();
    }
    function arm(remaining = 3) {
      stop();
      if (!context) {
        context = new AudioContext(); global.DublineAudioDevices?.registerContext(context);
        masterGain = context.createGain(); masterGain.connect(context.destination); updateMaster();
      }
      const token = generation;
      // `remaining`: seconds until the line starts. Beats fall 3, 2 and 1 s before it; when
      // re-armed later (once the video really plays) the beats already in the past are skipped.
      const schedule = () => {
        if (token !== generation) return;
        const now = context.currentTime;
        const lineAt = now + Math.max(0, Number(remaining) || 0);
        for (let beat = 3; beat >= 1; beat--) if (lineAt - beat >= now - 0.01) beep(Math.max(now, lineAt - beat));
      };
      if (global.DublineAudioDevices) global.DublineAudioDevices.resume(context).then(schedule).catch(() => {});
      else if (context.state === 'suspended') context.resume().then(schedule).catch(() => {});
      else schedule();
    }
    function beep(at) {
      // Only the speaker destination. Never the microphone graph, take bus or export.
      const oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0, at); gain.gain.linearRampToValueAtTime(0.12 * Math.max(0, Math.min(1, Number(volume()) || 0)), at + 0.005);
      gain.gain.linearRampToValueAtTime(0, at + 0.075);
      oscillator.connect(gain); gain.connect(masterGain);
      nodes.add(oscillator);
      oscillator.onended = () => { nodes.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(at); oscillator.stop(at + 0.08);
    }
    return { arm, stop };
  }
  const api = { preparation, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DublineAdr = api;
})(typeof window !== 'undefined' ? window : globalThis);
