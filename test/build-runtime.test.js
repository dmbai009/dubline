const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function coldBuild(installerStatus = 0) {
  const filename = path.resolve(__dirname, '../tools/build-distributions.js');
  const actualRequire = createRequire(filename);
  const module = { exports: {} }, commands = [], writes = [];
  let runtimeReady = false;
  const dependency = name => {
    if (name === 'node:fs') return { ...fs, promises: { ...fs.promises,
      writeFile: async (...args) => { writes.push(args); }
    } };
    if (name === 'node:child_process') return { spawnSync: (executable, args) => {
      if (executable === 'git') return { status: 0, stdout: 'a'.repeat(40) + '\n' };
      commands.push(args);
      if (args[0] === actualRequire.resolve('electron/install.js')) {
        runtimeReady = installerStatus === 0;
        return { status: installerStatus };
      }
      if (args[0] === actualRequire.resolve('electron-builder/cli')) {
        // beforePack copies LICENSE/Chromium notices from electron/dist.
        if (!runtimeReady) throw new Error('ENOENT: Electron runtime licenses are missing');
      }
      return { status: 0 };
    } };
    return actualRequire(name);
  };
  dependency.resolve = actualRequire.resolve;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: dependency, module, __dirname: path.dirname(filename),
    process: { env: {}, execPath: process.execPath }, console, Buffer
  }, { filename });
  return { build: module.exports.buildUnpacked, commands, writes, actualRequire };
}

test('a clean Windows build prepares Electron before the packaging license hook', async () => {
  const fixture = coldBuild();
  await fixture.build();
  const installer = fixture.commands.findIndex(args => args[0] === fixture.actualRequire.resolve('electron/install.js'));
  const builder = fixture.commands.findIndex(args => args[0] === fixture.actualRequire.resolve('electron-builder/cli'));
  assert.ok(installer >= 0 && builder > installer);
  assert.deepEqual(Array.from(fixture.commands[builder].slice(-2)), ['--publish', 'never']);
  assert.equal(fixture.writes.length, 1);
  const marker = JSON.parse(fixture.writes[0][1]);
  assert.equal(marker.version, require('../package.json').version);
  assert.equal(marker.commit, 'a'.repeat(40));
  assert.equal(marker.channel, 'github-setup');
});

test('a failed Electron preparation stops the build before packaging or writing its marker', async () => {
  const fixture = coldBuild(9);
  await assert.rejects(fixture.build(), /failed \(9\)/);
  assert.equal(fixture.commands.length, 1);
  assert.equal(fixture.writes.length, 0);
});
