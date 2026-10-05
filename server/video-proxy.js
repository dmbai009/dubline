// Working video is bounded; the original is retained separately for final streamcopy.
const fs = require('node:fs');
const { MAX_VIDEO_MB, HttpError } = require('./config');
const { runFfmpeg, probeAudioDuration, extractAudioTracks } = require('./media');
const BUDGET = MAX_VIDEO_MB * 1024 * 1024;
function checkSpace(folder, bytes) {
  const disk = fs.statfsSync(folder);
  if (disk.bavail * disk.bsize < bytes) throw new HttpError(507, 'Not enough disk space', 'project.diskSpace');
}
async function createVideoProxy(source, output, videoUrl, {signal, progress = () => {}} = {}) {
  const duration = probeAudioDuration(source);
  if (!duration || duration > 86400) throw new HttpError(400, 'Cannot determine video duration', 'error.processingFailed');
  checkSpace(require('node:path').dirname(output), BUDGET + Math.ceil(duration * 32000));
  // Leave room for container overhead and the first fallback audio track.
  const bitrate = Math.max(64000, Math.min(1200000, Math.floor((BUDGET * 0.78 * 8 / duration) - 96000)));
  progress('compressing', 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    await runFfmpeg(['-copyts', '-start_at_zero', '-i', source, '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-b:v', String(Math.floor(bitrate * (attempt ? 0.65 : 1))),
      '-maxrate', String(Math.floor(bitrate * (attempt ? 0.65 : 1))), '-bufsize', String(bitrate * 2), '-fps_mode', 'passthrough',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', output], 'Could not create working video',
      {signal, timeoutMs: 2 * 60 * 60 * 1000, onProgress: time => progress('compressing', Math.min(99, Math.round(time / duration * 100)))});
    if (fs.statSync(output).size <= BUDGET) break;
    if (attempt) throw new HttpError(413, 'Working copy exceeds the limit', 'error.videoTooBig', {max: MAX_VIDEO_MB});
  }
  const proxyDuration = probeAudioDuration(output);
  if (!proxyDuration || Math.abs(proxyDuration - duration) > 0.25) throw new HttpError(400, 'Working video timing differs from source', 'proxy.timing');
  progress('audio', 0);
  const tracks = await extractAudioTracks(videoUrl, source, signal);
  signal?.throwIfAborted();
  progress('audio', 100);
  return {duration: proxyDuration, tracks};
}
module.exports = {createVideoProxy, checkSpace};
