// Device preference only: never include it in a room or portable project.
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    let mode = 'auto';
    try { mode = api.normalize(root.localStorage.getItem('dubline_video_acceleration')); } catch { /* Optional local storage. */ }
    root.DublineVideoAcceleration = { ...api, get: () => mode, set: value => {
      mode = api.normalize(value);
      try { root.localStorage.setItem('dubline_video_acceleration', mode); } catch { /* Current preference still applies. */ }
      root.dispatchEvent(new Event('dubline-acceleration-changed')); return mode;
    } };
  }
})(typeof window === 'undefined' ? globalThis : window, () => {
  const normalize = value => ['auto', 'on', 'off'].includes(value) ? value : 'auto';
  function wantsHardware(mode, info = {}) {
    mode = normalize(mode);
    return mode === 'on' || mode === 'auto' && info.duration >= 30 && info.width * info.height >= 640 * 360;
  }
  function preference(mode, info) { return wantsHardware(mode, info) ? 'prefer-hardware' : 'prefer-software'; }
  async function encoderPreference(mb, codec, config, mode, info) {
    const preferred = preference(mode, info);
    for (const hint of preferred === 'prefer-hardware' ? [preferred, 'prefer-software'] : [preferred]) {
      try { if (await mb.canEncodeVideo(codec, { ...config, hardwareAcceleration: hint })) return hint; }
      catch { /* A rejected device probe must still allow a software probe. */ }
    }
    throw Error('exportVideo.unsupported');
  }
  async function decoderPreference(track, hint) {
    const config = await track.getDecoderConfig();
    for (const candidate of hint === 'prefer-hardware' ? [hint, 'prefer-software'] : [hint]) {
      try { if ((await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: candidate })).supported) return candidate; }
      catch { /* Try the software decoder after a rejected hardware probe. */ }
    }
    throw Error('exportVideo.unsupported');
  }
  return { normalize, wantsHardware, preference, encoderPreference, decoderPreference };
});
