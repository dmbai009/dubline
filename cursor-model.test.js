const test = require('node:test'), assert = require('node:assert/strict');
const { normalize } = require('./public/cursor-model');
test('semantic cursor validation accepts known rows and excludes stale scope, forged metadata and invalid geometry', () => {
  const packet = { sessionId: 'scene', seq: 1, active: true, time: 123.5, rowType: 'role', rowKey: 'Hero', relativeY: .25 };
  assert.deepEqual(normalize({ ...packet, nick: 'Forged', actorId: 'other' }, 'scene', ['Hero']), packet);
  for (const change of [{ sessionId: 'old' }, { time: NaN }, { time: 50000 }, { relativeY: Infinity }, { relativeY: -1 }, { seq: 1.5 }, { rowKey: 'Missing' }, { rowType: 'screen' }]) assert.equal(normalize({ ...packet, ...change }, 'scene', ['Hero']), null);
  assert.deepEqual(normalize({ sessionId: 'scene', seq: 2, active: false }, 'scene', []), { sessionId: 'scene', seq: 2, active: false });
});
