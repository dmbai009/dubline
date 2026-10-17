// Bounded, deduplicated inspection of actual video packets; no media paths leave this module.
const fs = require('node:fs'), path = require('node:path');
const cache = new Map();
let active = 0;
function inspect(file) {
  const stat = fs.statSync(file), key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (!stat.isFile()) return Promise.reject(Error('exportVideo.sourceMissing'));
  if (cache.has(key)) return cache.get(key).promise;
  if (active >= 2) return Promise.reject(Error('project.busy'));
  active++;
  const entry = { pending: true };
  const promise = (async () => {
    const mb = await import('mediabunny');
    const input = new mb.Input({ source: new mb.FilePathSource(file), formats: mb.ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track || !await track.getCodec()) throw Error('exportVideo.sourceMissing');
      const [duration, codec, stats, metrics, format] = await Promise.all([
        track.computeDuration(), track.getCodec(), track.computePacketStats(Infinity, { metadataOnly: true }), track.computeFrameRateMetrics({ targetPacketCount: Infinity }), input.getFormat()
      ]);
      return { width: track.displayWidth, height: track.displayHeight, codedWidth: track.codedWidth, codedHeight: track.codedHeight,
        rotation: track.rotation, duration, codec, fps: metrics.frameRateIsConstant ? metrics.underlyingFrameRate : stats.averagePacketRate,
        variableFrameRate: !metrics.frameRateIsConstant, bitrate: stats.averageBitrate > 0 ? stats.averageBitrate : null, container: format.name,
        extension: ['mp4', 'mkv', 'webm'].includes(path.extname(file).slice(1).toLowerCase()) ? path.extname(file).slice(1).toLowerCase() : /matroska/i.test(format.mimeType) ? 'mkv' : /webm/i.test(format.mimeType) ? 'webm' : 'mp4', fileSize: stat.size };
    } catch (error) {
      // Legacy original codecs can still be copied by FFmpeg even when Mediabunny cannot demux them.
      // Keep unknown stream bitrate/FPS unknown, so custom controls remain closed.
      const inspection = await require('./video-compatibility').inspectVideo(file);
      const extension = path.extname(file).slice(1).toLowerCase();
      if (!['mp4', 'mkv', 'webm'].includes(extension)) throw error;
      return { width: inspection.width, height: inspection.height, codec: inspection.codec, duration: require('./media').probeAudioDuration(file),
        codedWidth: inspection.width, codedHeight: inspection.height, fps: null, variableFrameRate: null, bitrate: null, container: extension.toUpperCase(), extension, fileSize: stat.size };
    } finally { input.dispose(); }
  })().catch(error => { cache.delete(key); throw error; }).finally(() => { active--; entry.pending = false; while (cache.size > 32) { const oldest = [...cache].find(([, value]) => !value.pending); if (!oldest) break; cache.delete(oldest[0]); } });
  entry.promise = promise; cache.set(key, entry); return promise;
}
module.exports = { inspect };
