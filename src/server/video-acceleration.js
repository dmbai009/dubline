const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const policy = require('../public/video-acceleration');
const { runFfmpeg } = require('./media');
const ffmpeg = process.env.DUBLINE_FFMPEG_PATH || require('ffmpeg-static');
const execute = promisify(execFile);
const candidates = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'];
function encoderArgs(encoder) {
  const preset = { libx264: ['-preset', 'veryfast'], h264_nvenc: ['-preset', 'p4'], h264_qsv: ['-preset', 'medium'], h264_amf: ['-quality', 'balanced'], h264_videotoolbox: ['-allow_sw', '0'] };
  if (!Object.hasOwn(preset, encoder)) throw Error('Unknown video encoder');
  return ['-c:v', encoder, ...preset[encoder], '-pix_fmt', ['libx264', 'h264_videotoolbox'].includes(encoder) ? 'yuv420p' : 'nv12'];
}
function createAcceleration({ list = async signal => {
  const result = await execute(ffmpeg, ['-hide_banner', '-encoders'], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, signal });
  return [...result.stdout.matchAll(/^\s*[A-Z.]{6}\s+(\S+)/gm)].map(match => match[1]);
}, probe = async (encoder, signal) => runFfmpeg(['-f', 'lavfi', '-i', 'color=size=640x360:rate=30', '-frames:v', '2', '-an', ...encoderArgs(encoder), '-b:v', '800k', '-f', 'null', '-'], 'Video acceleration check', { signal, timeoutMs: 5000 }) } = {}) {
  const tested = new Map();
  async function choose(mode, info, signal) {
    signal?.throwIfAborted();
    if (!policy.wantsHardware(mode, info)) return 'libx264';
    let available;
    try { available = await list(signal); } catch (error) { if (signal?.aborted || error.name === 'AbortError') throw error; return 'libx264'; }
    for (const encoder of candidates.filter(name => available.includes(name))) {
      signal?.throwIfAborted();
      const cached = tested.get(encoder);
      if (cached && cached.until > Date.now()) { if (cached.ok) return encoder; continue; }
      try { await probe(encoder, signal); tested.set(encoder, { ok: true, until: Date.now() + 600000 }); return encoder; }
      catch (error) { if (signal?.aborted || error.name === 'AbortError') throw error; tested.set(encoder, { ok: false, until: Date.now() + 600000 }); }
    }
    return 'libx264';
  }
  async function run({ mode, info, signal, onBackend = () => {} }, task) {
    const encoder = await choose(mode, info, signal);
    onBackend(encoder, false);
    try { return await task(encoder); }
    catch (error) {
      if (encoder === 'libx264' || signal?.aborted || error.name === 'AbortError') throw error;
      tested.set(encoder, { ok: false, until: Date.now() + 600000 });
      onBackend('libx264', true); signal?.throwIfAborted(); return task('libx264');
    }
  }
  return { choose, run };
}
module.exports = { ...createAcceleration(), createAcceleration, encoderArgs };
