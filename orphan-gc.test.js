const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { collect } = require('./server/orphanGc');
test('idle orphan cleanup protects inactive scenes, trash, originals, unknown files and recent staging', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-gc-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roots = Object.fromEntries(['data', 'uploads', 'packs'].map(name => { const folder = path.join(dir, name); fs.mkdirSync(folder); return [name, folder]; }));
  const names = ['custom_1234567890123_abcdef', 'custom_1234567890123_bcdefg', 'custom_1234567890123_cdefgh', 'custom_1234567890123_defghi'];
  for (const name of names) fs.mkdirSync(path.join(roots.uploads, name));
  fs.mkdirSync(path.join(roots.data, '.project-export-ABCdef')); fs.writeFileSync(path.join(roots.uploads, 'User Project.dubline'), 'keep');
  const rooms = { main: { sessions: { inactive: { videoUrl: `/uploads/${names[0]}/video.mp4`, originalVideoUrl: `/uploads/${names[1]}/source_video.mp4`, deletedLines: [{ lines: [{ line: { audioUrl: `/uploads/${names[2]}/old.webm` } }] }] } } } };
  assert.deepEqual(await collect({ roots, rooms, idle: () => false, grace: 0, now: Date.now() + 1000 }), []);
  assert.deepEqual(await collect({ roots, rooms }), []);
  const removed = await collect({ roots, rooms, grace: 0, now: Date.now() + 1000 });
  assert.deepEqual(removed.sort(), [path.join(roots.data, '.project-export-ABCdef'), path.join(roots.uploads, names[3])].sort());
  for (const name of names.slice(0, 3)) assert.equal(fs.existsSync(path.join(roots.uploads, name)), true);
  assert.equal(fs.readFileSync(path.join(roots.uploads, 'User Project.dubline'), 'utf8'), 'keep');
});
test('orphan cleanup preserves scene references when configured roots are filesystem aliases', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-gc-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'workspace'), alias = path.join(dir, 'alias');
  fs.mkdirSync(workspace);
  fs.symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const roots = Object.fromEntries(['data', 'uploads', 'packs'].map(name => {
    fs.mkdirSync(path.join(workspace, name)); return [name, path.join(alias, name)];
  }));
  const referenced = 'custom_1234567890123_abcdef', orphan = 'custom_1234567890123_defghi';
  for (const name of [referenced, orphan]) {
    fs.mkdirSync(path.join(workspace, 'uploads', name));
    fs.writeFileSync(path.join(workspace, 'uploads', name, 'video.mp4'), name);
  }
  const rooms = { main: { sessions: { inactive: { videoUrl: `/uploads/${referenced}/video.mp4` } } } };
  const removed = await collect({ roots, rooms, grace: 0, now: Date.now() + 1000 });
  assert.deepEqual(removed, [path.join(workspace, 'uploads', orphan)]);
  assert.equal(fs.readFileSync(path.join(workspace, 'uploads', referenced, 'video.mp4'), 'utf8'), referenced);
});
test('orphan cleanup rechecks new live references after IO through an aliased root', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-gc-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'workspace'), alias = path.join(dir, 'alias');
  fs.mkdirSync(workspace);
  fs.symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const roots = Object.fromEntries(['data', 'uploads', 'packs'].map(name => {
    fs.mkdirSync(path.join(workspace, name)); return [name, path.join(alias, name)];
  }));
  const name = 'custom_1234567890123_abcdef', target = path.join(workspace, 'uploads', name);
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'video.mp4'), 'new scene');
  const rooms = { main: { videoUrl: '' } }, lstat = fs.promises.lstat;
  t.mock.method(fs.promises, 'lstat', async file => {
    const stat = await lstat(file);
    if (file === target) rooms.main.videoUrl = `/uploads/${name}/video.mp4`;
    return stat;
  });
  assert.deepEqual(await collect({ roots, rooms, grace: 0, now: Date.now() + 1000 }), []);
  assert.equal(rooms.main.videoUrl, `/uploads/${name}/video.mp4`);
  assert.equal(fs.readFileSync(path.join(target, 'video.mp4'), 'utf8'), 'new scene');
});
