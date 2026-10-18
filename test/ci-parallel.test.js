const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { suiteFiles, weightOf, shardsOf } = require('../tools/e2e-shard');
const root = path.resolve(__dirname, '..');

test('every browser suite is scheduled exactly once, including new unmeasured files', () => {
  const files = suiteFiles();
  for (const total of [1, 3, 6, files.length]) {
    const shards = shardsOf(files, total);
    assert.equal(shards.length, total);
    assert.ok(shards.every(shard => shard.length > 0));
    assert.deepEqual(shards.flat().sort(), [...files].sort());
    assert.deepEqual(shardsOf([...files].reverse(), total), shards);
  }
  const future = 'e2e/future-unmeasured.e2e.js';
  const extended = [...files, future];
  const shards = shardsOf(extended, 6, file => file === future ? 10000 : weightOf(file));
  assert.deepEqual(shards.flat().sort(), extended.sort());
  assert.ok(weightOf('test/ci-parallel.test.js') > 0, 'unmeasured files use a positive estimate');
  assert.throws(() => shardsOf([files[0], files[0]], 1), /Duplicate/);
});

test('duration-based scheduling balances slow suites without changing test content', () => {
  const files = suiteFiles();
  const totals = shardsOf(files, 6).map(shard => shard.reduce((sum, file) => sum + weightOf(file), 0));
  const previous = shardsOf(files, 3).map(shard => shard.reduce((sum, file) => sum + weightOf(file), 0));
  assert.ok(Math.max(...totals) - Math.min(...totals) < 15000);
  assert.ok(Math.max(...totals) < Math.max(...previous) * 0.6);
  const weighted = shardsOf(['a', 'b', 'c', 'd'], 2, file => ({ a: 100, b: 90, c: 20, d: 10 })[file]);
  assert.deepEqual(weighted, [['a', 'd'], ['b', 'c']]);
});

test('shard CLI lists suites without running them and refuses invalid shard requests', () => {
  const script = path.join(root, 'tools/e2e-shard.js');
  const run = args => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
  const listed = run(['--list', '1', '6']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.split(/\r?\n/).filter(line => line.startsWith('  ')).map(line => line.trim()), shardsOf(suiteFiles(), 6)[0]);
  for (const args of [['0', '6'], ['7', '6'], ['1.5', '6'], ['1', '1000'], ['1', '6', '8'], ['--unknown', '1', '6']]) {
    assert.equal(run(args).status, 2, args.join(' '));
  }
});

test('shard runner propagates failures and keeps tests sequential inside each runner', () => {
  const filename = path.join(root, 'tools/e2e-shard.js');
  for (const result of [{ status: 13 }, { status: null }, { error: new Error('spawn failure') }]) {
    let invocation;
    const exit = new Error('exit');
    let status;
    assert.throws(() => vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      __dirname: path.dirname(filename), module: undefined,
      require: Object.assign(name => name === 'node:child_process' ? {
        spawnSync: (executable, args) => { invocation = { executable, args }; return result; }
      } : name === './e2e-durations.json' ? require('../tools/e2e-durations.json') : require(name), { main: undefined }),
      console: { log() {}, error() {} },
      process: { execPath: process.execPath, argv: ['node', filename, '1', '6'], exit: code => { status = code; throw exit; } }
    }), error => error === exit);
    assert.equal(status, result.status === 13 ? 13 : 1);
    assert.equal(invocation.executable, process.execPath);
    assert.ok(invocation.args.includes('--test-concurrency=1'));
    assert.deepEqual(Array.from(invocation.args.slice(3)), shardsOf(suiteFiles(), 6)[0]);
  }
});

function workflow(name) {
  return yaml.load(fs.readFileSync(path.join(root, '.github/workflows', name + '.yml'), 'utf8'));
}

test('ordinary and release CI share checks bound to the requested immutable commit', () => {
  const checks = workflow('checks');
  const regular = workflow('test');
  const release = workflow('release');
  assert.equal(regular.jobs.checks.uses, './.github/workflows/checks.yml');
  assert.equal(release.jobs.checks.uses, regular.jobs.checks.uses);
  assert.equal(regular.jobs.checks.with.ref, '${{ github.sha }}');
  assert.equal(release.jobs.checks.with.ref, '${{ needs.revision.outputs.sha }}');
  assert.equal(release.jobs.checks.with.release, true);
  assert.deepEqual(regular.on.push.branches, ['**']);
  assert.deepEqual(checks.jobs.source.steps.filter(step => step.run).map(step => step.run),
    ['npm ci', 'npm run check', 'npm test']);
  for (const job of Object.values(checks.jobs)) {
    assert.equal(job.steps.find(step => step.uses?.startsWith('actions/checkout@')).with.ref, '${{ inputs.ref }}');
    assert.ok(!job.needs, 'check groups can start independently');
  }
  assert.equal(checks.jobs.browser.env.DUBLINE_REQUIRE_BROWSER, '1');
  assert.equal(checks.jobs.browser.strategy['fail-fast'], false);
  assert.equal(checks.jobs.electron.strategy['fail-fast'], false);
  const shards = checks.jobs.browser.strategy.matrix.shard;
  assert.deepEqual(shards, [1, 2, 3, 4, 5, 6]);
  const command = checks.jobs.browser.steps.find(step => step.run?.includes('e2e-shard.js'));
  assert.equal(command.shell, 'bash'); // Explicit bash enables pipefail for tee.
  assert.match(command.run, /e2e-shard\.js \$\{\{ matrix.shard \}\} 6 /);
  for (const job of Object.values(checks.jobs)) for (const step of job.steps) assert.ok(!step['continue-on-error']);
});

test('all previous native checks run once, with release-only checks preserved', () => {
  const job = workflow('checks').jobs.electron;
  const commands = release => job.strategy.matrix.group.flatMap(group => job.steps
    .filter(step => step.if && vm.runInNewContext(step.if, { matrix: { group }, inputs: { release } }))
    .map(step => step.run));
  const ordinary = ['ui', 'hosting', 'editor', 'updates', 'workflow'].map(name => 'npm run test:electron:' + name);
  const extra = ['npm run test:electron:projects', 'npm run test:electron:take-mix',
    'node tools/electron-shell-smoke.js', 'node tools/electron-portable-helper-smoke.js'];
  assert.deepEqual(commands(false).sort(), ordinary.sort());
  assert.deepEqual(commands(true).sort(), [...ordinary, ...extra].sort());
});

test('release draft waits for every check and verified artifact job before any release write', () => {
  const release = workflow('release');
  assert.equal(release.permissions.contents, 'read');
  assert.deepEqual(release.jobs.draft.needs.slice().sort(), ['checks', 'revision', 'windows']);
  assert.equal(release.jobs.draft.if, undefined, 'default success gate must not be bypassed');
  assert.equal(release.jobs.draft.permissions.contents, 'write');
  assert.equal(release.jobs.windows.needs, 'revision');
  assert.equal(release.jobs.windows.env.DUBLINE_RELEASE_SHA, '${{ needs.revision.outputs.sha }}');
  const packaging = release.jobs.windows.steps.filter(step => step.run).map(step => step.run);
  for (const command of ['npm run dist', 'node tools/verify-release-artifacts.js', 'npm run test:electron:portable',
    'node tools/build-update-qa.js', 'node tools/electron-portable-update-smoke.js', 'node tools/electron-setup-update-smoke.js']) {
    assert.ok(packaging.includes(command), command);
  }
  assert.ok(packaging.every(command => !command.includes('gh release')));
  const upload = release.jobs.windows.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  const download = release.jobs.draft.steps.find(step => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(upload.with.name, download.with.name);
  assert.equal(upload.with['if-no-files-found'], 'error');
  const draft = release.jobs.draft.steps.find(step => step.run);
  assert.match(draft.run, /Downloaded artifacts do not match/);
  assert.match(draft.run, /Get-FileHash/);
  assert.match(draft.run, /Refusing to change an already published release/);
  assert.match(draft.run, /--draft/);
  assert.ok(!draft.run.includes('--draft=false'));
});
