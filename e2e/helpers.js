// Общие помощники для браузерных тестов (npm run test:e2e).
// Каждый набор поднимает свой сервер во временных папках и не трогает рабочие data/ и uploads/.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const ROOT = path.join(__dirname, '..');
const FIXTURE_PACK = 'test-scene.zip';
const FIXTURE_LINES = [
  { id: 1, character: 'Hero', caption: 'Hello there', start: 3.0, end: 4.5 },
  { id: 2, character: 'Friend', caption: 'Hi, how are you?', start: 5.0, end: 6.5 },
  { id: 3, character: 'Hero', caption: 'Pretty good', start: 7.5, end: 9.0 },
  // Как во многих паках: голос в MP3 и указано только начало — длину сервер должен узнать из файла
  { id: 4, character: 'Friend', caption: 'Nice to hear', start: 9.5, end: 11.0, mp3: true, startOnly: true }
];
const SCENE_SECONDS = 12;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- Браузер ----------
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

const CHROME = findChrome();
const skipReason = CHROME ? false : 'Chrome/Edge не найден — укажите путь в переменной CHROME_PATH';

async function launchBrowser(port, { fakeAudioFile = null } = {}) {
  const puppeteer = require('puppeteer-core');
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      // Вместо «пищалки» можно подать заранее подготовленный звук как голос в микрофон
      ...(fakeAudioFile ? [`--use-file-for-fake-audio-capture=${fakeAudioFile}%noloop`] : []),
      '--autoplay-policy=no-user-gesture-required',
      // Второй «адрес» сервера: с него игроки выглядят как зашедшие через туннель (нужно для P2P)
      '--host-resolver-rules=MAP dubline.test 127.0.0.1',
      `--unsafely-treat-insecure-origin-as-secure=http://dubline.test:${port}`
    ]
  });
}

// ---------- Тестовая сцена (генерируется ffmpeg, без чужого контента) ----------
let fixtureZip = null;

// «Голос» для микрофона: 2 с тишины (подготовка), фраза, тихий хвост, затем тишина
function buildVoiceFile({ speechFrom, loudUntil, tailUntil, total = 12 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-voice-'));
  const file = path.join(dir, 'voice.wav');
  const volume = `if(between(t,${speechFrom},${loudUntil}),0.5,if(between(t,${loudUntil},${tailUntil}),0.02,0))`;
  runFfmpeg(['-f', 'lavfi', '-i', `sine=frequency=300:duration=${total}`, '-af', `volume='${volume}':eval=frame`, '-ar', '48000', '-ac', '1', file]);
  return file;
}

function runFfmpeg(args) {
  const ffmpeg = require('ffmpeg-static');
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (result.status !== 0) throw new Error(`ffmpeg: ${String(result.stderr)}`);
}

function buildFixturePack() {
  if (fixtureZip) return fixtureZip;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-fixture-'));
  runFfmpeg(['-f', 'lavfi', '-i', `testsrc=size=640x360:rate=25:duration=${SCENE_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SCENE_SECONDS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'dub_video.mp4')]);
  runFfmpeg(['-f', 'lavfi', '-i', `sine=frequency=220:duration=${SCENE_SECONDS}`, '-ar', '22050', '-ac', '1', path.join(dir, '_backing_track.wav')]);

  const zip = new AdmZip();
  zip.addLocalFile(path.join(dir, 'dub_video.mp4'));
  zip.addLocalFile(path.join(dir, '_backing_track.wav'));
  for (const line of FIXTURE_LINES) {
    const name = String(line.id).padStart(3, '0');
    const voice = path.join(dir, `${name}.${line.mp3 ? 'mp3' : 'wav'}`);
    const codec = line.mp3 ? ['-c:a', 'libmp3lame'] : [];
    runFfmpeg(['-f', 'lavfi', '-i', `sine=frequency=${300 + line.id * 60}:duration=${line.end - line.start}`, '-ar', '22050', '-ac', '1', ...codec, voice]);
    zip.addLocalFile(voice);
    const timestamps = line.startOnly ? `[${line.start}]` : `[${line.start}, ${line.end}]`;
    zip.addFile(`${name}.ini`, Buffer.from(
      `caption = ${line.caption}\ndub_characters = ["${line.character}"]\ndub_timestamps = ${timestamps}\n`
    ));
  }
  fixtureZip = path.join(dir, FIXTURE_PACK);
  zip.writeZip(fixtureZip);
  return fixtureZip;
}

// ---------- Сервер ----------
let nextPort = 3400 + Math.floor(Math.random() * 200);

async function startServer() {
  const port = nextPort++;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-e2e-'));
  const dirs = { data: path.join(base, 'data'), uploads: path.join(base, 'uploads'), packs: path.join(base, 'packs') };
  Object.values(dirs).forEach(dir => fs.mkdirSync(dir, { recursive: true }));
  fs.copyFileSync(buildFixturePack(), path.join(dirs.packs, FIXTURE_PACK));

  const server = { port, dirs, log: '', proc: null };
  server.start = () => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), DUBLINE_DATA_DIR: dirs.data, DUBLINE_UPLOAD_DIR: dirs.uploads, DUBLINE_PACKS_DIR: dirs.packs, DUBLINE_OPEN_BROWSER: '' }
    });
    server.proc = proc;
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${server.log}`)), 15000);
    proc.stdout.on('data', chunk => {
      server.log += chunk;
      if (String(chunk).includes('Сервер запущен')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.stderr.on('data', chunk => { server.log += chunk; });
  });
  server.stop = () => new Promise(resolve => {
    if (!server.proc || server.proc.exitCode !== null) return resolve();
    server.proc.once('exit', resolve);
    server.proc.kill();
  });
  // Перезапуск с теми же данными; ждем секунду, чтобы отложенное сохранение успело записаться
  server.restart = async () => {
    await wait(1300);
    await server.stop();
    await server.start();
  };
  server.url = (room, host = 'localhost') => `http://${host}:${port}/?room=${encodeURIComponent(room)}`;
  server.cleanup = async () => {
    await server.stop();
    fs.rmSync(base, { recursive: true, force: true });
  };
  await server.start();
  return server;
}

// ---------- Игроки ----------
async function openPlayer(browser, url, nick, { helpSeen = true, viewport = { width: 1600, height: 900 }, context = null } = {}) {
  const ctx = context || await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(viewport);
  page.errors = [];
  page.dialogs = [];
  page.promptAnswer = null;
  page.on('pageerror', err => page.errors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error' && !/404|Failed to load resource|ERR_CONNECTION_REFUSED|net::ERR_FAILED/.test(msg.text())) page.errors.push(msg.text());
  });
  page.on('dialog', dialog => {
    page.dialogs.push(dialog.message());
    dialog.accept(dialog.type() === 'prompt' ? (page.promptAnswer || '') : undefined);
  });
  await page.evaluateOnNewDocument((name, seen) => {
    if (name) localStorage.setItem('dubline_nick', name);
    if (seen) localStorage.setItem('dubline_help_seen', '1');
  }, nick, helpSeen);
  await page.goto(url);
  await waitFor(page, () => typeof socket !== 'undefined' && socket.connected, 10000);
  return page;
}

// Ждем, пока условие в браузере станет истинным (вместо фиксированных пауз)
async function waitFor(page, fn, timeout = 10000, ...args) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await page.evaluate(fn, ...args);
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await wait(100);
  }
  throw new Error(`waitFor timed out after ${timeout}ms: ${fn.toString().slice(0, 160)} (last: ${JSON.stringify(last)})`);
}

async function waitUntil(fn, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn()) return true;
    await wait(100);
  }
  throw new Error(`waitUntil timed out: ${fn.toString().slice(0, 160)}`);
}

async function loadFixture(page) {
  await page.evaluate(name => loadSavedPack(name), FIXTURE_PACK);
  await waitFor(page, () => session && session.loaded && document.querySelectorAll('.line-block').length === 4, 15000);
}

async function claimAndSelect(page, lineId) {
  await page.evaluate(id => { selectLine(session.lines.find(l => l.id === id)); claimSingleLine(id); }, lineId);
  await waitFor(page, (id, ) => { const l = session.lines.find(x => x.id === id); return getLineOwner(l) === myName && document.getElementById('recBtn'); }, 5000, lineId);
}

// Записывает дубль реплики фальшивым микрофоном Chrome и ждет, пока он появится на сервере
async function recordTake(page, lineId, timeout = 20000) {
  await page.evaluate(id => { selectLine(session.lines.find(l => l.id === id)); }, lineId);
  await waitFor(page, () => document.getElementById('recBtn'), 5000);
  await page.evaluate(id => handleStudioRecord(id), lineId);
  return waitFor(page, id => { const l = session.lines.find(x => x.id === id); return recordState === 'idle' && l.audioUrl ? l.audioUrl : null; }, timeout, lineId);
}

// Видео тестовой сцены отдельным файлом (для импорта «видео + субтитры»)
function fixtureVideoPath() {
  return path.join(path.dirname(buildFixturePack()), 'dub_video.mp4');
}

function uploadFileCount(server) {
  return fs.readdirSync(server.dirs.uploads).filter(name => name.startsWith('line_')).length;
}

module.exports = {
  FIXTURE_LINES, FIXTURE_PACK, SCENE_SECONDS,
  skipReason, wait, launchBrowser, startServer, openPlayer, waitFor, waitUntil,
  loadFixture, claimAndSelect, recordTake, uploadFileCount, buildFixturePack, buildVoiceFile, fixtureVideoPath
};
