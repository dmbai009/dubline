const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { DesktopStorage } = require('./electron-storage');
async function fixture(t) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dubline-storage-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const profile = path.join(dir, 'Профиль'), parent = path.join(dir, 'Другой диск');
  await fs.promises.mkdir(parent); await fs.promises.mkdir(profile);
  const contents = new Map([
    ['data/rooms.json', Buffer.from(JSON.stringify({ main: { videoUrl: '/uploads/scene/video.mp4', originalVideoUrl: '/uploads/scene/source_video.mkv', lines: [{ audioUrl: '/uploads/take.webm' }] } }))],
    ['uploads/scene/video.mp4', crypto.randomBytes(1024)], ['uploads/scene/source_video.mkv', crypto.randomBytes(4 * 1024 * 1024)],
    ['uploads/take.webm', crypto.randomBytes(512)], ['packs/アニメ.zip', crypto.randomBytes(256)]
  ]);
  for (const [relative, bytes] of contents) { const file = path.join(profile, relative); await fs.promises.mkdir(path.dirname(file), { recursive: true }); await fs.promises.writeFile(file, bytes); }
  await fs.promises.writeFile(path.join(profile, 'language.json'), '"ru"');
  await fs.promises.mkdir(path.join(profile, 'Cache')); await fs.promises.writeFile(path.join(profile, 'Cache', 'browser'), 'keep');
  return { dir, profile, parent, contents, storage: new DesktopStorage(profile) };
}
async function verify(root, contents) { for (const [relative, bytes] of contents) assert.deepEqual(await fs.promises.readFile(path.join(root, relative)), bytes, relative); }
test('storage migration preserves original/proxy/takes/packs/URLs, persists choice, retains profile preferences', async t => {
  const { profile, parent, contents, storage } = await fixture(t), progress = [];
  const info = await storage.choose(parent, false, item => progress.push(item));
  assert.equal(info.root, path.join(parent, 'Dubline')); assert.equal(info.pending, ''); assert.equal(storage.busy, false);
  await verify(info.root, contents);
  for (const folder of ['data', 'uploads', 'packs']) assert.equal(fs.existsSync(path.join(profile, folder)), false);
  assert.equal(await fs.promises.readFile(path.join(profile, 'language.json'), 'utf8'), '"ru"');
  assert.equal(fs.existsSync(path.join(profile, 'Cache', 'browser')), true);
  assert.equal(await new DesktopStorage(profile).prepare(), info.root);
  assert.equal(progress.at(-1).completed, progress.at(-1).total);
});
test('live workspace only schedules move; next launch also preserves recordings saved after folder choice', async t => {
  const { profile, parent, contents, storage } = await fixture(t);
  const info = await storage.choose(parent, true);
  assert.equal(info.root, profile); assert.equal(info.pending, path.join(parent, 'Dubline')); assert.equal(fs.existsSync(info.pending), false);
  await verify(profile, contents); await fs.promises.writeFile(path.join(profile, 'uploads', 'late.webm'), 'late recording');
  assert.equal(await new DesktopStorage(profile).prepare(), info.pending); await verify(info.pending, contents);
  assert.equal(await fs.promises.readFile(path.join(info.pending, 'uploads', 'late.webm'), 'utf8'), 'late recording');
});
test('overlap and occupied destination cannot overwrite projects or unrelated files', async t => {
  const { profile, parent, contents, storage } = await fixture(t);
  await assert.rejects(storage.choose(profile, false), { code: 'overlap' });
  const target = path.join(parent, 'Dubline'); await fs.promises.mkdir(target); await fs.promises.writeFile(path.join(target, 'unrelated'), 'keep');
  await assert.rejects(storage.choose(parent, false), { code: 'occupied' }); await verify(profile, contents);
  assert.equal(await fs.promises.readFile(path.join(target, 'unrelated'), 'utf8'), 'keep'); assert.equal(storage.info().root, profile);
});
test('destination populated after scheduling is rejected before deleting original storage', async t => {
  const { profile, parent, contents, storage } = await fixture(t);
  const info = await storage.choose(parent, true); await fs.promises.mkdir(info.pending); await fs.promises.writeFile(path.join(info.pending, 'other'), 'new');
  await assert.rejects(new DesktopStorage(profile).prepare(), { code: 'occupied' }); await verify(profile, contents);
});
test('empty destination accepted; choosing current location cancels a pending move', async t => {
  const { parent, dir, storage } = await fixture(t); await fs.promises.mkdir(path.join(parent, 'Dubline')); await storage.choose(parent, false);
  const other = path.join(dir, 'Another'); await fs.promises.mkdir(other); await storage.choose(other, true); await storage.choose(parent, true);
  assert.equal(storage.info().pending, ''); assert.equal(storage.info().root, path.join(parent, 'Dubline'));
});
test('missing configured disk or damaged preference never silently opens empty AppData projects', async t => {
  const { profile, parent, contents, storage } = await fixture(t); await storage.choose(parent, false);
  const disconnected = path.join(parent, 'disconnected'); await fs.promises.rename(storage.info().root, disconnected);
  await assert.rejects(new DesktopStorage(profile).prepare(), { code: 'missing' }); await verify(disconnected, contents); assert.equal(fs.existsSync(path.join(profile, 'data')), false);
  await fs.promises.writeFile(path.join(profile, 'storage.json'), '{broken'); await assert.rejects(new DesktopStorage(profile).prepare(), { code: 'config' });
});
test('disk space failure retains source and releases busy flag', async t => {
  const { profile, parent, contents, storage } = await fixture(t), original = fs.promises.statfs;
  fs.promises.statfs = async () => ({ bavail: 0, bsize: 4096 });
  try { await assert.rejects(storage.choose(parent, false), { code: 'space' }); } finally { fs.promises.statfs = original; }
  await verify(profile, contents); assert.equal(fs.existsSync(path.join(parent, 'Dubline')), false); assert.equal(storage.busy, false);
});
test('interrupted copy rolls back destination and preserves source bytes', async t => {
  const { profile, parent, contents, storage } = await fixture(t), original = fs.promises.copyFile;
  fs.promises.copyFile = async () => { throw Object.assign(new Error('Disk write failed'), { code: 'EIO' }); };
  try { await assert.rejects(storage.choose(parent, false), { code: 'EIO' }); } finally { fs.promises.copyFile = original; }
  await verify(profile, contents); assert.deepEqual(await fs.promises.readdir(parent), []); assert.equal(storage.info().root, profile);
});
test('preference commit failure rolls back published destination; original projects remain available', async t => {
  const { profile, parent, contents, storage } = await fixture(t), original = storage.save.bind(storage);
  storage.save = async config => { if (!config.pending) throw new Error('Profile unavailable'); return original(config); };
  await assert.rejects(storage.choose(parent, false), /Profile unavailable/); await verify(profile, contents);
  assert.deepEqual(await fs.promises.readdir(parent), []); assert.equal(new DesktopStorage(profile).info().root, profile);
});
test('concurrent request is refused while migration is busy', async t => {
  const { parent, storage } = await fixture(t); let release, entered, paused = false;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; }), original = storage.validate.bind(storage);
  storage.validate = async selected => { if (!paused) { paused = true; entered(); await gate; } return original(selected); };
  const running = storage.choose(parent, false); await started; await assert.rejects(storage.prepare(), { code: 'busy' }); await assert.rejects(storage.choose(parent, false), { code: 'busy' }); release(); await running;
});
test('source and destination junctions cannot redirect copying or cleanup', async t => {
  const { profile, parent, dir, contents, storage } = await fixture(t), outside = path.join(dir, 'outside');
  await fs.promises.mkdir(outside); await fs.promises.writeFile(path.join(outside, 'keep'), 'keep');
  const link = path.join(profile, 'uploads', 'link'); await fs.promises.symlink(outside, link, 'junction');
  await assert.rejects(storage.choose(parent, false), { code: 'symlink' }); await fs.promises.unlink(link);
  await fs.promises.symlink(outside, path.join(parent, 'Dubline'), 'junction'); await assert.rejects(storage.choose(parent, false), { code: 'occupied' });
  await verify(profile, contents); assert.equal(await fs.promises.readFile(path.join(outside, 'keep'), 'utf8'), 'keep');
});
test('physical source above 1 GiB migrates without whole-file buffering', async t => {
  const { profile, parent, storage } = await fixture(t);
  const file = path.join(profile, 'uploads', 'large_source_video.mp4');
  const size = 1024 * 1024 * 1024 + 64, marker = crypto.randomBytes(32);
  const handle = await fs.promises.open(file, 'wx');
  try { await handle.truncate(size); await handle.write(marker, 0, marker.length, 0); await handle.write(marker, 0, marker.length, size - marker.length); }
  finally { await handle.close(); }
  const baseline = process.memoryUsage().rss; let peak = baseline;
  const interval = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  let info; try { info = await storage.choose(parent, false); } finally { clearInterval(interval); }
  const result = await fs.promises.open(path.join(info.root, 'uploads', 'large_source_video.mp4'), 'r');
  try {
    assert.equal((await result.stat()).size, size);
    const buffer = Buffer.alloc(32); await result.read(buffer, 0, 32, 0); assert.deepEqual(buffer, marker);
    await result.read(buffer, 0, 32, size - 32); assert.deepEqual(buffer, marker);
  } finally { await result.close(); }
  assert.ok(peak - baseline < 128 * 1024 * 1024, 'migration RSS must stay bounded');
  assert.equal(fs.existsSync(file), false);
  console.log('Storage >1 GiB copy; observed peak RSS delta: ' + Math.round((peak - baseline) / 1048576) + ' MiB');
});
test('actual profile-to-workspace volume migration preserves projects across disk boundaries', async t => {
  const { profile, contents, storage } = await fixture(t);
  const destination = await fs.promises.mkdtemp(path.join(__dirname, '.storage-volume-'));
  t.after(() => fs.promises.rm(destination, {recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const info = await storage.choose(destination, false); await verify(info.root, contents);
  assert.equal(fs.existsSync(path.join(profile, 'uploads')), false);
  console.log('Storage volume migration: ' + path.parse(profile).root + ' -> ' + path.parse(info.root).root);
});
