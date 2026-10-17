const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('source relocation preserves standalone storage defaults and explicit overrides', () => {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'src/server/config.js'), 'utf8');
  const load = env => {
    const context = { __dirname: path.join(root, 'src/server'), process: { env }, module: { exports: {} },
      require: name => name === 'fs' ? { existsSync: () => true } : require(name) };
    vm.runInNewContext(source, context);
    return context.module.exports;
  };
  const defaults = load({});
  assert.equal(defaults.ROOT_DIR, root);
  assert.equal(defaults.PUBLIC_DIR, path.join(root, 'src/public'));
  assert.equal(defaults.DATA_DIR, path.join(root, 'data'));
  assert.equal(defaults.UPLOAD_DIR, path.join(root, 'public/uploads'));
  assert.equal(defaults.PACKS_DIR, path.join(root, 'public/packs'));
  const env = { DUBLINE_DATA_DIR: path.join(root, 'audit/data'), DUBLINE_UPLOAD_DIR: path.join(root, 'audit/uploads'), DUBLINE_PACKS_DIR: path.join(root, 'audit/packs') };
  const overridden = load(env);
  assert.equal(overridden.DATA_DIR, env.DUBLINE_DATA_DIR);
  assert.equal(overridden.ROOMS_FILE, path.join(env.DUBLINE_DATA_DIR, 'rooms.json'));
  assert.equal(overridden.UPLOAD_DIR, env.DUBLINE_UPLOAD_DIR);
  assert.equal(overridden.PACKS_DIR, env.DUBLINE_PACKS_DIR);
  assert.equal(overridden.PUBLIC_DIR, defaults.PUBLIC_DIR);
});
