// Shared export bounds. Personal preferences never change the project mix.
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DublineVideoExportPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const AUDIO_BITRATE = 192000;
  const valid = value => Number.isFinite(value) && value > 0;
  const formats = Object.freeze({ mp4: { codec: 'avc', audio: 'aac', mime: 'video/mp4' }, webm: { codec: 'vp9', audio: 'opus', mime: 'video/webm' } });
  function axisLimits(info) {
    const swapped = Math.abs(info.rotation || 0) % 180 === 90;
    return { width: valid(info.codedWidth) ? swapped ? info.codedHeight : info.codedWidth : info.width, height: valid(info.codedHeight) ? swapped ? info.codedWidth : info.codedHeight : info.height };
  }
  function dimensions(info, height) {
    if (!valid(info.width) || !valid(info.height) || !valid(height)) return null;
    const limits = axisLimits(info);
    const scale = Math.min(1, height / Math.min(info.width, info.height), limits.width / info.width, limits.height / info.height);
    return { width: Math.floor(info.width * scale / 2) * 2, height: Math.floor(info.height * scale / 2) * 2 };
  }
  function validate(info, options) {
    if (!formats[options.format] || options.codec !== formats[options.format].codec) return 'exportVideo.unsupported';
    if (![info.width, info.height, info.bitrate].every(valid)) return 'exportVideo.unknownBounds';
    if (![options.width, options.height].every(valid)) return 'exportVideo.resolutionLimit';
    if (!valid(options.bitrate)) return 'exportVideo.bitrateLimit';
    if (!Number.isInteger(options.width) || !Number.isInteger(options.height) || options.width % 2 || options.height % 2 || options.width < 2 || options.height < 2) return 'exportVideo.resolutionLimit';
    const limits = axisLimits(info);
    if (options.width > Math.min(info.width, limits.width) || options.height > Math.min(info.height, limits.height) || Math.abs(options.width / options.height - info.width / info.height) > 2 / options.height) return 'exportVideo.resolutionLimit';
    if (options.bitrate > info.bitrate) return 'exportVideo.bitrateLimit';
    if (options.fps != null && (!valid(info.fps) || !valid(options.fps) || options.fps > info.fps)) return 'exportVideo.fpsLimit';
    return null;
  }
  function estimate(info, options = {}) {
    const bitrate = options.mode === 'custom' ? options.bitrate : info.bitrate;
    if (!valid(info.duration) || !valid(bitrate)) return null;
    return Math.ceil(info.duration * (bitrate + AUDIO_BITRATE) / 8 * 1.02);
  }
  function filename(title, extension) {
    return `Dubline_${String(title || 'scene').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100)}_export.${extension}`;
  }
  return Object.freeze({ AUDIO_BITRATE, formats, valid, axisLimits, dimensions, validate, estimate, filename });
});
