const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { HttpError } = require('./config');
const { logEvent } = require('./log');
const { diskPathForUrl } = require('./files');

// ==========================================
// ЗВУКОВЫЕ ДОРОЖКИ ВИДЕО (например, японская и русская в одной серии)
// Браузерный плеер играет только одну дорожку, поэтому каждую вытаскиваем отдельным файлом.
// ==========================================
const LANGUAGE_NAMES = { rus: 'Русский', ru: 'Русский', jpn: 'Японский', ja: 'Японский', eng: 'English', en: 'English', ukr: 'Українська', uk: 'Українська', und: '' };

function probeAudioStreams(file) {
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 20000 });
  const lines = (result.stderr || '').split(/\r?\n/);
  const streams = [];
  let current = null;
  for (const line of lines) {
    const stream = /^\s*Stream #\d+:\d+(?:\[[^\]]*\])?(?:\((\w+)\))?: (\w+): ([^,\s]+)/.exec(line);
    if (stream) {
      current = stream[2] === 'Audio' ? { language: stream[1] || 'und', codec: stream[3], title: '' } : null;
      if (current) streams.push(current);
      continue;
    }
    const title = /^\s+title\s*:\s*(.+)$/.exec(line);
    if (title && current && !current.title) current.title = title[1].trim();
  }
  return streams;
}

const audioTrackJobs = new Map(); // videoUrl -> Promise (чтобы не извлекать одно и то же дважды)

function extractAudioTracks(videoUrl) {
  if (audioTrackJobs.has(videoUrl)) return audioTrackJobs.get(videoUrl);
  const job = (async () => {
    const videoPath = diskPathForUrl(videoUrl);
    if (!videoPath || !fs.existsSync(videoPath)) return [];
    const streams = probeAudioStreams(videoPath);
    if (streams.length < 2) return [];
    const dir = path.dirname(videoPath);
    const dirUrl = videoUrl.slice(0, videoUrl.lastIndexOf('/'));
    const tracks = [];
    for (let i = 0; i < streams.length; i++) {
      const name = `track_${i}.m4a`;
      const out = path.join(dir, name);
      if (!fs.existsSync(out)) {
        const codecArgs = streams[i].codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k'];
        await runFfmpeg(['-i', videoPath, '-map', `0:a:${i}`, '-vn', ...codecArgs, '-movflags', '+faststart', out], 'Не удалось извлечь звуковую дорожку');
      }
      const language = streams[i].language;
      tracks.push({
        index: i,
        url: `${dirUrl}/${encodeURIComponent(name)}`,
        language,
        label: streams[i].title || LANGUAGE_NAMES[language] || language,
        codec: streams[i].codec
      });
    }
    return tracks;
  })().catch(err => {
    logEvent(null, `⚠ Звуковые дорожки не извлечены: ${err.message}`, 'warn');
    return [];
  });
  audioTrackJobs.set(videoUrl, job);
  return job;
}

// Длина MP3/OGG и прочих форматов: у WAV она есть в заголовке, для остальных спрашиваем ffmpeg.
// Без этого у реплик без явного конца в паке длина молча становилась 3 секунды.
function probeAudioDuration(file) {
  if (!ffmpegPath || !fs.existsSync(file)) return null;
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8', timeout: 10000 });
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(result.stderr || '');
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + parseFloat(match[3]);
  return seconds > 0.05 ? seconds : null;
}

function getWavDuration(buffer) {
  try {
    if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
    const byteRate = buffer.readUInt32LE(28);
    let offset = 36;
    while (offset < buffer.length - 8) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      if (chunkId === 'data') return chunkSize / byteRate;
      offset += 8 + chunkSize;
    }
    return (buffer.length - 44) / byteRate;
  } catch (e) {
    return null;
  }
}

function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new HttpError(408, `${label}: превышено время обработки`));
    }, 10 * 60 * 1000);
    child.stderr.on('data', chunk => {
      if (stderr.length < 8 * 1024 * 1024) stderr += chunk.toString();
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(new HttpError(500, `${label}: ${err.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const detail = stderr.trim().split(/\r?\n/).slice(-3).join(' ');
      if (detail) console.error(`[Dubline] ${label}: ${detail}`);
      reject(new HttpError(400, label));
    });
  });
}

function findEmbeddedSubtitleMap(filePath) {
  const probe = spawnSync(ffmpegPath, ['-hide_banner', '-i', filePath], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024
  });
  if (probe.error) throw new HttpError(500, `Не удалось проверить MKV: ${probe.error.message}`);
  const output = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  // Разбираем дорожки субтитров вместе с их названиями (title) и языком
  const tracks = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    const stream = /Stream #0:(\d+)(?:\[[^\]]*\])?(?:\((\w+)\))?: (\w+): ([^,\s]+)/.exec(line);
    if (stream) {
      current = stream[3] === 'Subtitle' && /^(ass|ssa|subrip|srt|webvtt)$/i.test(stream[4])
        ? { index: stream[1], language: stream[2] || '', title: '', order: tracks.length }
        : null;
      if (current) tracks.push(current);
      continue;
    }
    const title = /^\s+title\s*:\s*(.+)$/.exec(line);
    if (title && current && !current.title) current.title = title[1].trim();
  }
  if (!tracks.length) return null;

  // В релизах часто несколько дорожек: «Надписи», «Песни», «Полные». Для озвучки нужны реплики
  const score = track => {
    const name = `${track.title} ${track.language}`.toLowerCase();
    let value = 0;
    if (/sign|надпис|song|песн|forced|караоке|karaoke|opening|ending|\bop\b|\bed\b/.test(name)) value -= 10;
    if (/full|полн|dialog|диалог|субтитры/.test(name)) value += 5;
    if (/rus|ru\b|русск/.test(name)) value += 1;
    return value;
  };
  const chosen = [...tracks].sort((a, b) => score(b) - score(a) || a.order - b.order)[0];
  if (tracks.length > 1) {
    logEvent(null, `🔤 В MKV ${tracks.length} дорожки субтитров (${tracks.map(t => t.title || t.language || `#${t.index}`).join(', ')}), выбрана: ${chosen.title || chosen.language || `#${chosen.index}`}`);
  }
  return `0:${chosen.index}`;
}

module.exports = {
  extractAudioTracks,
  probeAudioDuration,
  getWavDuration,
  runFfmpeg,
  findEmbeddedSubtitleMap
};
