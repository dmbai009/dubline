// Stream a reduced mono signal instead of decoding hours of audio in the browser.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ffmpegPath } = require('./media');
const { diskPathForUrl } = require('./files');
const jobs = new Map();
const RATE = 48000;
const BIN = 1200; // full-band peaks every 25 ms, without losing high-frequency speech
const MAX_SAMPLES = RATE * 12 * 60 * 60;
let active = 0;
const waiting = [];
async function slot() {
  if (active >= 2) await new Promise(resolve => waiting.push(resolve));
  else active++;
}
function release() { const next = waiting.shift(); if (next) next(); else active--; }
function extract(full) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', full,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    let tail = Buffer.alloc(0), count = 0, peak = 0, stderr = '';
    const peaks = [];
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.stdout.on('data', chunk => {
      const data = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      const end = data.length - data.length % 4;
      for (let i = 0; i < end; i += 4) {
        peak = Math.max(peak, Math.min(1, Math.abs(data.readFloatLE(i)) || 0));
        if (++count % BIN === 0) { peaks.push(Math.round(peak * 1000) / 1000); peak = 0; }
      }
      tail = data.subarray(end);
      if (count > MAX_SAMPLES) child.kill();
    });
    child.stderr.on('data', data => { if (stderr.length < 4096) stderr += data.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr || 'Waveform extraction failed'));
      if (count % BIN) peaks.push(Math.round(peak * 1000) / 1000);
      resolve({ version: 2, duration: count / RATE, step: BIN / RATE, peaks });
    });
  });
}
async function waveform(url) {
  const full = diskPathForUrl(url);
  if (!full) throw new Error('Invalid media source');
  const stat = await fs.promises.stat(full);
  const key = crypto.createHash('sha256').update(`${full}|${stat.size}|${stat.mtimeMs}|v2`).digest('hex');
  const cache = path.join(path.dirname(full), `.waveform-${key}.json`);
  if (jobs.has(key)) return jobs.get(key);
  const job = (async () => {
    try {
      const saved = JSON.parse(await fs.promises.readFile(cache, 'utf8'));
      if (saved.version === 2 && Array.isArray(saved.peaks)) return saved;
    } catch { /* missing/corrupt cache: rebuild */ }
    await slot();
    try {
      const result = await extract(full);
      await fs.promises.writeFile(cache, JSON.stringify(result)).catch(() => {});
      return result;
    } finally { release(); }
  })();
  jobs.set(key, job);
  try { return await job; } finally { jobs.delete(key); }
}
module.exports = { waveform };
