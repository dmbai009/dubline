const { test } = require('node:test'), assert = require('node:assert/strict');
const model = require('../src/public/scene-review-model'), access = require('../src/server/sceneReview');
const effect = id => ({ id, type: 'radio', enabled: true, amount: .8, parameters: {} });
const scene = () => ({ loaded: true, videoUrl: '/video.mp4', trackOrder: ['Role'], roleEffects: {}, voicePresets: {}, lines: [{ id: 1, character: 'Role' }, { id: 2, character: 'Role', audioUrl: '/own.wav', recordedBy: 'Actor', needsRetake: true }, { id: 3, character: 'Role', audioUrl: '/hidden.wav', recordedBy: 'Other' }] });
test('unfinished lines are warnings and a readiness summary does not require media downloads', () => {
  const report = model.inspect(scene()); assert.equal(report.total, 3); assert.equal(report.recorded, 2); assert.equal(report.unrecorded, 1); assert.equal(report.retakes, 1); assert.equal(report.errors.length, 0); assert.equal(report.warnings.length, 2);
});
test('hidden recording availability and quality are excluded from participant details', () => {
  const report = model.inspect(scene(), { allow: line => line.recordedBy === 'Actor', availability: { '/hidden.wav': 'missing', '/own.wav': 'temporary' }, quality: { '/hidden.wav': { warnings: ['clipped'] }, '/own.wav': { warnings: ['quiet'] } } });
  assert.equal(report.errors.length, 0); assert.ok(report.issues.every(issue => issue.lineId !== 3)); assert.ok(report.warnings.some(issue => issue.key === 'quality.quiet'));
});
test('pending operations, broken links and unsafe resolved chains are export blockers', () => {
  const room = scene(); room.lines[1].voicePresetId = 'missing'; room.lines[2].effects = Array.from({ length: 9 }, (_, i) => effect('s' + i));
  const report = model.inspect(room, { pending: 2 }); assert.equal(report.errors.length, 3); assert.deepEqual(report.errors.map(issue => issue.key), ['review.pending', 'review.presetMissing', 'review.chain']);
});
test('Blind Mode file checks use the same visibility rules for author, host and revealed takes', () => {
  const room = { blindMode: true, blindPlayers: [], characterClaims: {} }, line = { character: 'Role', audioUrl: '/voice.wav', recordedBy: 'Actor' };
  assert.equal(access.canListen(room, line, 'Actor'), true); assert.equal(access.canListen(room, line, 'Host'), false); assert.equal(access.canListen(room, { ...line, blindRevealed: true }, 'Host'), true);
  assert.equal(access.canListen({ ...room, blindMode: false, blindPlayers: ['Actor'] }, line, 'Other'), false);
});
