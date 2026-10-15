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
