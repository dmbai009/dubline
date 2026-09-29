// ==========================================
// РАЗБОР ПАКОВ (Voxalike / The Choicer Voicer) И СУБТИТРОВ
// ==========================================
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR, MAX_UNPACKED_MB, HttpError } = require('./config');
const { probeAudioDuration, getWavDuration } = require('./media');

function parseLineContent(content, fileName, fallbackId, originalAudioUrl, audioDuration) {
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

  let caption = '';
  const capMatch = content.match(/caption\s*=\s*(.*?)(\r?\n|$)/i);
  if (capMatch) caption = capMatch[1].trim().replace(/^["']|["']$/g, '');

  let character = 'Персонаж';
  const charMatch = content.match(/dub_characters\s*=\s*(.*?)(\r?\n|$)/i);
  if (charMatch) {
    let raw = charMatch[1].trim().replace(/[\[\]"']/g, '');
    if (raw) character = raw.split(',')[0].trim() || 'Персонаж';
  }

  let start = 0;
  let end = 0;
  const timeMatch = content.match(/dub_timestamps\s*=\s*(.*?)(\r?\n|$)/i);
  if (timeMatch) {
    const nums = timeMatch[1].match(/[-+]?[0-9]*\.?[0-9]+/g);
    if (nums && nums.length > 0) {
      start = parseFloat(nums[0]) || 0;
      if (nums.length > 1) {
        end = parseFloat(nums[1]) || start + 3.0;
      } else if (audioDuration) {
        end = start + audioDuration;
      } else {
        end = start + 3.0;
      }
    }
  }

  const numInName = fileName.match(/\d+/);
  const id = numInName ? parseInt(numInName[0], 10) : fallbackId;

  return {
    id,
    character,
    caption,
    start: Number(start.toFixed(2)),
    end: Number(end.toFixed(2)),
    originalAudioUrl: originalAudioUrl || null,
    claimedBy: null,
    ...emptyTake()
  };
}

// Поля записанного дубля. Эффекты, питч, обрезка и сдвиг не меняют файл — применяются при воспроизведении
function emptyTake() {
  return {
    audioUrl: null,
    audioStart: null,     // когда на таймлайне начинается файл дубля (с учетом ручного сдвига)
    recordedStart: null,  // исходное audioStart сразу после записи (для кнопки «сбросить сдвиг»)
    trimStart: null,      // найденные границы речи внутри файла, в секундах
    trimEnd: null,
    trimEnabled: true,
    effect: 'none',
    pitch: 0,
    recordedBy: null,     // кто записал дубль (чтобы его можно было послушать, даже когда реплика освобождена)
    uploadId: null        // id отправки: повтор той же отправки не сохраняется дважды
  };
}

function parseSeconds(raw) {
  const num = parseFloat(raw);
  return Number.isFinite(num) ? Number(num.toFixed(3)) : null;
}

// Пак распаковывается один раз в uploads/pack_<имя>, повторные запуски используют готовую папку
function readPack(buffer, packName, forceExtract) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new HttpError(400, 'Файл не похож на .zip архив');
  }

  const entries = zip.getEntries().filter(e => !e.isDirectory);
  const unpackedBytes = entries.reduce((sum, e) => sum + (e.header.size || 0), 0);
  if (unpackedBytes > MAX_UNPACKED_MB * 1024 * 1024) {
    throw new HttpError(413, `Распакованный пак больше ${MAX_UNPACKED_MB} МБ`);
  }

  const dirName = 'pack_' + packName.replace(/\.zip$/i, '');
  const targetDir = path.join(UPLOAD_DIR, dirName);
  const readyMarker = path.join(targetDir, '.ready');

  if (forceExtract) fs.rmSync(targetDir, { recursive: true, force: true });
  const needExtract = !fs.existsSync(readyMarker);
  if (needExtract) fs.mkdirSync(targetDir, { recursive: true });

  let videoFile = null;
  let backingFile = null;
  const rawLineFiles = [];
  const audioFilesMap = {};
  const audioByNumber = {};
  const audioDurations = {};

  entries.forEach(entry => {
    // Плоская распаковка: берем только имя файла (защита от "../" в путях архива)
    const name = entry.entryName.split(/[\\/]/).pop();
    if (!name || name.startsWith('.')) return;

    const lower = name.toLowerCase();
    const ext = path.extname(lower);
    const stem = path.basename(lower, ext);
    const isVoice = ['.wav', '.mp3', '.ogg'].includes(ext) && !lower.startsWith('_');
    const isText = (ext === '.ini' || ext === '.txt') && !lower.startsWith('_') && !lower.includes('readme');

    if (lower === 'dub_video.mp4') videoFile = name;
    if (lower.includes('backing_track')) backingFile = name;

    if (!needExtract && !isText && ext !== '.wav') {
      if (isVoice) {
        audioFilesMap[stem] = name;
        const num = (name.match(/\d+/) || [null])[0];
        if (num !== null) audioByNumber[parseInt(num, 10)] = name;
      }
      return;
    }

    const data = entry.getData();
    if (needExtract) fs.writeFileSync(path.join(targetDir, name), data);

    if (isVoice) {
      audioFilesMap[stem] = name;
      const num = (name.match(/\d+/) || [null])[0];
      if (num !== null) audioByNumber[parseInt(num, 10)] = name;

      if (ext === '.wav') {
        const dur = getWavDuration(data);
        if (dur) audioDurations[name] = dur;
      }
    }

    if (isText) {
      const textContent = data.toString('utf8');
      if (/caption|dub_timestamps|dub_characters/i.test(textContent)) {
        rawLineFiles.push({ name, stem, content: textContent });
      }
    }
  });

  if (needExtract) fs.writeFileSync(readyMarker, '');

  // Длины оригинальных голосов в MP3/OGG (для WAV уже прочитаны из заголовка)
  Object.values(audioFilesMap).forEach(name => {
    if (audioDurations[name] === undefined) {
      const duration = probeAudioDuration(path.join(targetDir, name));
      if (duration) audioDurations[name] = duration;
    }
  });

  const urlFor = file => `/uploads/${encodeURIComponent(dirName)}/${encodeURIComponent(file)}`;

  rawLineFiles.sort((a, b) => {
    const numA = (a.name.match(/\d+/) || [0])[0];
    const numB = (b.name.match(/\d+/) || [0])[0];
    return parseInt(numA, 10) - parseInt(numB, 10);
  });

  const lines = rawLineFiles.map((item, idx) => {
    const num = (item.name.match(/\d+/) || [idx + 1])[0];
    const lineId = parseInt(num, 10);
    const matchedAudio = audioFilesMap[item.stem] || audioByNumber[lineId];
    const origUrl = matchedAudio ? urlFor(matchedAudio) : null;
    const dur = matchedAudio ? audioDurations[matchedAudio] : null;

    return parseLineContent(item.content, item.name, lineId, origUrl, dur);
  });

  return {
    title: packName.replace(/\.zip$/i, ''),
    videoUrl: videoFile ? urlFor(videoFile) : '',
    backingUrl: backingFile ? urlFor(backingFile) : '',
    lines
  };
}

function isMkvFile(file) {
  return /\.mkv$/i.test(file.originalname || '') || file.mimetype === 'video/x-matroska';
}

function isMp4File(file) {
  return /\.mp4$/i.test(file.originalname || '') || file.mimetype === 'video/mp4';
}

function isSubtitleFile(file) {
  return /\.(ass|ssa|srt|vtt)$/i.test(file.originalname || '');
}

function parseAssTime(str) {
  const parts = String(str || '').trim().split(':');
  if (parts.length < 3) return 0;
  const h = parseFloat(parts[0]) || 0;
  const m = parseFloat(parts[1]) || 0;
  const s = parseFloat(parts[2]) || 0;
  return h * 3600 + m * 60 + s;
}

function parseSrtTime(h, m, s, ms) {
  const hours = parseFloat(h ? h.replace(':', '') : 0) || 0;
  const minutes = parseFloat(m) || 0;
  const seconds = parseFloat(s) || 0;
  const millis = parseFloat(ms) || 0;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

// Строка ASS в режиме рисования ({\p1} и т.п.) или сама похожа на векторные команды «m 0 0 l 157 0…»
function isAssDrawing(rawText) {
  if (/\{[^}]*\\p[1-9]/i.test(rawText)) return true;
  return /^m\s+-?\d+(\.\d+)?\s+-?\d+(\.\d+)?(\s+[mlbspc]?\s*-?\d+(\.\d+)?)*\s*$/i.test(rawText.replace(/\{[^}]*\}/g, '').trim());
}

// Убираем теги оформления; \N, \n и неразрывный \h превращаем в пробелы
function cleanAssText(rawText) {
  return rawText.replace(/\{[^}]*\}/g, '').replace(/\\[Nnh]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseSubtitles(buffer, fileName) {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const ext = path.extname(fileName || '').toLowerCase();
  const lines = [];

  if (ext === '.ass' || ext === '.ssa') {
    const rawLines = text.split(/\r?\n/);
    let formatFields = [];
    let idCounter = 1;

    for (const line of rawLines) {
      const trimmed = line.trim();
      if (/^Format:/i.test(trimmed)) {
        formatFields = trimmed.replace(/^Format:\s*/i, '').split(',').map(s => s.trim().toLowerCase());
      } else if (/^Dialogue:/i.test(trimmed)) {
        const valStr = trimmed.replace(/^Dialogue:\s*/i, '');
        const maxSplits = formatFields.length > 0 ? formatFields.length - 1 : 9;
        const parts = [];
        let curr = valStr;
        for (let i = 0; i < maxSplits; i++) {
          const idx = curr.indexOf(',');
          if (idx === -1) break;
          parts.push(curr.slice(0, idx).trim());
          curr = curr.slice(idx + 1);
        }
        parts.push(curr.trim());

        let start = 0, end = 0, character = 'Персонаж', caption = '';
        if (formatFields.length > 0) {
          const sIdx = formatFields.indexOf('start');
          const eIdx = formatFields.indexOf('end');
          const nIdx = formatFields.indexOf('name');
          const tIdx = formatFields.indexOf('text');
          if (sIdx !== -1 && parts[sIdx]) start = parseAssTime(parts[sIdx]);
          if (eIdx !== -1 && parts[eIdx]) end = parseAssTime(parts[eIdx]);
          if (nIdx !== -1 && parts[nIdx]) character = parts[nIdx] || 'Персонаж';
          if (tIdx !== -1 && parts[tIdx]) caption = parts[tIdx];
        } else {
          start = parseAssTime(parts[1] || '0');
          end = parseAssTime(parts[2] || '0');
          character = parts[4] || 'Персонаж';
          caption = parts[9] || '';
        }

        // Векторные рисунки тайпсеттеров (\p1…) — это не реплики, пропускаем
        if (isAssDrawing(caption)) continue;
        caption = cleanAssText(caption);
        if (caption) {
          lines.push({
            id: idCounter++,
            character: character || 'Персонаж',
            caption,
            start: Number(start.toFixed(2)),
            end: Number(Math.max(start + 0.5, end).toFixed(2)),
            originalAudioUrl: null,
            claimedBy: null,
            ...emptyTake()
          });
        }
      }
    }
  } else {
    // SRT / VTT
    const blocks = text.split(/\r?\n\r?\n+/);
    let idCounter = 1;
    for (const block of blocks) {
      const bLines = block.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (bLines.length < 2) continue;

      let timeLineIdx = bLines.findIndex(l => l.includes('-->'));
      if (timeLineIdx === -1) continue;

      const timeLine = bLines[timeLineIdx];
      const match = timeLine.match(/(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[,.](\d{3})/);
      if (!match) continue;

      const start = parseSrtTime(match[1], match[2], match[3], match[4]);
      const end = parseSrtTime(match[5], match[6], match[7], match[8]);

      let caption = bLines.slice(timeLineIdx + 1).join(' ').trim();
      caption = caption.replace(/<[^>]+>/g, '').trim();

      let character = 'Персонаж';
      const bracketed = caption.match(/^(?:\[([^\]]+)\]|\(([^)]+)\)):\s*(.*)$/);
      const prefixed = caption.match(/^([A-Za-zА-Яа-яЁёІіЇїЄєҐґ0-9_ .'-]{2,30}):\s*(.*)$/);
      if (bracketed) {
        character = (bracketed[1] || bracketed[2]).trim();
        caption = bracketed[3].trim();
      } else if (prefixed) {
        character = prefixed[1].trim();
        caption = prefixed[2].trim();
      }

      if (caption) {
        lines.push({
          id: idCounter++,
          character,
          caption,
          start: Number(start.toFixed(2)),
          end: Number(Math.max(start + 0.5, end).toFixed(2)),
          originalAudioUrl: null,
          claimedBy: null,
          ...emptyTake()
        });
      }
    }
  }

  return lines;
}

module.exports = {
  emptyTake,
  parseSeconds,
  readPack,
  isMkvFile,
  isMp4File,
  isSubtitleFile,
  isAssDrawing,
  cleanAssText,
  parseSubtitles
};
