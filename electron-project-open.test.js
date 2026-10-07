const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { projectPathsFromArgs, ProjectOpenCoordinator } = require('./electron-project-open');
test('shell arguments accept Unicode regular projects, reject missing files/directories and ignore flags', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-shell-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Проєкт з пробілами.DUBLINE'); fs.writeFileSync(file, 'project'); fs.mkdirSync(path.join(dir, 'directory.dubline'));
  const errors = [];
  assert.deepEqual(projectPathsFromArgs(['electron.exe', '--bad=missing.dubline', 'Проєкт з пробілами.DUBLINE', 'directory.dubline', 'missing.dubline', file], dir, error => errors.push(error.message)), [file]);
  assert.equal(errors.length, 2);
});
test('shell coordinator defers critical work, deduplicates queued paths and opens in order', async t => {
  let busy = true, waiting = 0; const opened = [], failures = [];
  const coordinator = new ProjectOpenCoordinator({ busy: async () => busy, open: async file => { opened.push(file); if (file === 'bad') throw Error('Invalid archive'); }, error: error => failures.push(error.message), waiting: () => waiting++ });
  t.after(() => coordinator.dispose());
  coordinator.enqueue('first'); coordinator.enqueue('first'); coordinator.enqueue('bad'); coordinator.enqueue('last');
  await new Promise(resolve => setTimeout(resolve, 20)); assert.deepEqual(opened, []); assert.equal(waiting, 1);
  busy = false;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(opened, ['first', 'bad', 'last']); assert.deepEqual(failures, ['Invalid archive']);
});
