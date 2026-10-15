const { test } = require('node:test'), assert = require('node:assert/strict'), model = require('./public/sequence-model');
const lines = [{ id: 4, start: 4, owner: 'Me', audioUrl: '/a.wav', needsRetake: true }, { id: 1, start: 1, owner: 'Other' }, { id: 2, start: 2, owner: 'Me' }, { id: 3, start: 3, owner: 'Me', audioUrl: '/a.wav' }];
const options = { nick: 'Me', owner: line => line.owner };
test('sequential recording finds only owned eligible lines in timeline order', () => {
  assert.equal(model.next(lines, null, options).id, 2); assert.equal(model.next(lines, 2, options), null); assert.equal(model.next(lines, 2, { ...options, mode: 'retake' }).id, 4);
});
test('filter navigation, temporary skips, the end and revoked ownership are explicit', () => {
  assert.equal(model.next(lines, null, { ...options, skipped: new Set([2]) }), null);
  assert.equal(model.next(lines, 2, { ...options, mode: 'filter', visible: line => line.id === 4 }).id, 4);
  assert.equal(model.next(lines, 4, { ...options, mode: 'filter' }), null); assert.equal(model.next(lines, null, { ...options, nick: 'Revoked' }), null);
});
