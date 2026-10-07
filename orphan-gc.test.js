const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { collect } = require('./server/orphanGc');
test('idle orphan cleanup protects inactive scenes, trash, originals, unknown files and recent staging', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-gc-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
