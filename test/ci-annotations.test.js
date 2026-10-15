// A red browser shard must say which suite broke. GitHub reports only an exit
// code, so the shard step pipes its output through tools/annotate-failures.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { failingTests, annotations, escapeAnnotation } = require('../tools/annotate-failures');

const LOG = [
  '▶ media',
  '  ✔ audio tracks (6331ms)',
  '  ✖ browser export (1997ms)',
  '    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  "    'vp9' !== 'avc'",
  '    test at e2e/video-export.e2e.js:58:12',
  '  ✖ plain failure without a location (12ms)',
  'ℹ fail 2',
].join('\n');

test('failing suites are named from the spec reporter output', () => {
  const failures = failingTests(LOG);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /^browser export — e2e\/video-export\.e2e\.js:58/);
  assert.match(failures[0], /AssertionError/);
  assert.equal(failures[1], 'plain failure without a location', 'a failure without a reference is still reported');
});

test('passing output produces no annotations and caps the list', () => {
  assert.deepEqual(annotations(failingTests('  ✔ all good (5ms)')), []);
  const many = annotations(Array.from({ length: 25 }, (_, i) => `test ${i}`));
  assert.equal(many.length, 21, '20 named failures plus a summary line');
  assert.match(many[20], /and 5 more/);
});

test('annotation payloads escape characters GitHub interprets', () => {
  assert.equal(escapeAnnotation('100% \r\n done'), '100%25 %0D%0A done');
});

test('real Node spec output reports each failure once with its own error and location', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline reporter '));
  try {
    const file = path.join(directory, 'two failures.cjs');
    fs.writeFileSync(file, "const {test}=require('node:test');\ntest('first failure',()=>{throw Error('FIRST_REASON')});\ntest('second failure',()=>{throw TypeError('SECOND_REASON')});\n");
    const env = { ...process.env, FORCE_COLOR: '1' }; delete env.NO_COLOR; delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', file], { encoding: 'utf8', env, windowsHide: true, timeout: 15000 });
    assert.equal(run.status, 1, run.error?.message);
    const failures = failingTests(run.stdout + run.stderr);
    assert.equal(failures.length, 2, JSON.stringify(failures));
    assert.ok(failures[0].includes(file + ':2'), failures[0]);
    assert.match(failures[0], /^first failure .*Error: FIRST_REASON/);
    assert.ok(failures[1].includes(file + ':3'), failures[1]);
    assert.match(failures[1], /^second failure .*TypeError: SECOND_REASON/);
    assert.doesNotMatch(failures[1], /FIRST_REASON/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('an interrupted log never takes another failed test error or a passing test location', () => {
  const failures = failingTests([
    '✖ first failure (1ms)',
    '✔ unrelated pass (2ms)',
    '  test at unrelated.js:30:4',
    '✖ second failure (3ms)',
    '  TypeError: SECOND_REASON',
    '  test at second.js:40:5',
  ].join('\n'));
  assert.deepEqual(failures, ['first failure', 'second failure — second.js:40 — TypeError: SECOND_REASON']);
});
