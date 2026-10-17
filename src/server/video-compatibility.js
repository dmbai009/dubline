// Inspect one decoded frame; retain only codec information, never paths or tags.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { ffmpegPath } = require('./media');
const { HttpError } = require('./config');
const inspections = new Map();
let activeInspections = 0;
function parseVideoInspection(output) {
  const input = output.split(/Output #/)[0];
  const line = input.split(/\r?\n/).find(value => /Stream #\d+:\d+.*: Video:/.test(value));
  const match = line && /Video:\s*(\w+)(?:\s+\(([^)]+)\))?[^,]*,\s*([^,]+),\s*(\d+)x(\d+)/.exec(line);
  if (!match) throw new HttpError(400, 'No readable video stream', 'error.processingFailed');
  const audioCodecs = [...input.matchAll(/Stream #\d+:\d+.*: Audio:\s*(\w+)/g)].map(value => value[1]);
  return Object.freeze({ codec: match[1], profile: match[2] || '', pixelFormat: match[3].split(/[\s(]/)[0], width: Number(match[4]), height: Number(match[5]), audioCodecs });
}
function requiresCompatibleProxy(info) {
  if (info.audioCodecs?.some(codec => !['aac', 'mp3', 'opus'].includes(codec))) return true;
  // H.264 4:2:0 8-bit is the portable working-video path. Preserve common
  // browser-native AV1/VP9 too; uncommon AVC profiles and legacy codecs need a copy.
  if (['av1', 'vp9'].includes(info.codec) && /^(yuv420p|yuv420p10le)$/.test(info.pixelFormat)) return false;
  return info.codec !== 'h264' || !/^(yuv420p|yuvj420p)$/.test(info.pixelFormat) || !/^(Constrained Baseline|Baseline|Main|High|Constrained High)$/.test(info.profile);
}
function inspectVideo(file, { signal } = {}) {
  signal?.throwIfAborted();
  const stat = fs.statSync(file), key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (inspections.has(key)) return inspections.get(key).promise;
  if (activeInspections >= 2) return Promise.reject(new HttpError(429, 'Video inspection is busy', 'project.busy'));
  activeInspections++;
  const entry = { pending: true };
  const job = new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-an', '-f', 'null', '-'], { windowsHide: true });
    let output = '', timedOut = false;
    const abort = () => child.kill();
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 20000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', chunk => { if (output.length < 128 * 1024) output += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      try {
        signal?.throwIfAborted();
        if (code !== 0) throw new HttpError(timedOut ? 408 : 400, 'Could not decode scene video', timedOut ? 'error.processingTimeout' : 'error.processingFailed');
        resolve(parseVideoInspection(output));
      } catch (error) { reject(error); }
    });
  }).catch(error => { inspections.delete(key); throw error; }).finally(() => {
    activeInspections--; entry.pending = false;
    while (inspections.size > 32) {
      const oldest = [...inspections].find(([, value]) => !value.pending);
      if (!oldest) break;
      inspections.delete(oldest[0]);
    }
  });
  entry.promise = job; inspections.set(key, entry);
  return job;
}
module.exports = { inspectVideo, parseVideoInspection, requiresCompatibleProxy };
