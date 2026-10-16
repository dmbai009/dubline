const { test } = require('node:test'), assert = require('node:assert/strict');
const chain = require('./public/voice-chain-model'), presets = require('./public/voice-preset-model');
const voices = require('./server/voiceChains'), catalog = require('./server/voicePresets'), timeline = require('./public/timeline-model');
const effect = (id = 'radio') => ({ id, type: 'radio', enabled: true, amount: .6, parameters: {} });
const scene = () => ({ trackOrder: ['Hero', 'Friend'], characterClaims: { Hero: 'Actor' }, roleEffects: {}, voicePresets: {}, lines: [{ id: 1, character: 'Hero', effect: 'none', pitch: 0, effects: [], inheritRoleEffects: true }] });
const create = room => ({ action: 'create', id: 'hero-preset', name: 'Hero', revision: 0, settings: { effects: [effect()] }, roleTargets: [presets.roleTarget(room, 'Hero')] });

test('Shift selection uses one track or an inclusive track/time rectangle and is independent of numbering', () => {
  const lines = [{ id: 90, character: 'A', start: 2, end: 3 }, { id: 1, character: 'B', start: 3, end: 4 }, { id: 50, character: 'A', start: 5, end: 6 }, { id: 2, character: 'C', start: 4, end: 5 }, { id: 3, character: 'B', start: 8, end: 9 }, { id: 4, character: 'B', start: 1, end: 2 }, { id: 5, character: 'B', start: 5.5, end: 7 }];
  assert.deepEqual(timeline.selectionRange(lines, ['A', 'B', 'C'], 90, 50), [90, 50]);
  assert.deepEqual(timeline.selectionRange(lines, ['A', 'B', 'C'], 90, 5), [90, 1, 50, 5]);
  assert.deepEqual(timeline.selectionRange(lines, ['C', 'B', 'A'], 5, 90), [90, 1, 50, 5]);
  assert.deepEqual(timeline.selectionRange(lines.filter(l => l.id !== 1), ['A', 'B', 'C'], 90, 5), [90, 50, 5]);
  assert.deepEqual(timeline.selectionRange(lines, ['A', 'B'], -1, 5), []);
});

test('role owners can edit only claimed roles, including host-created role presets', () => {
  const room = scene(), preset = { id: 'hero', name: 'Hero', createdBy: 'Host' };
  assert.ok(presets.canEditRole(room, 'Hero', 'Actor', false));
  assert.ok(presets.canEditPreset(room, preset, 'Actor', false));
  assert.equal(presets.canEditPreset(room, preset, 'Actor', false, 'delete'), false);
  assert.equal(presets.canEditRole(room, 'Friend', 'Actor', false), false);
  assert.equal(presets.canEditRole(room, 'Hero', 'Guest', false), false);
  room.lines[0].claimedBy = 'Actor'; delete room.characterClaims.Hero;
  assert.equal(presets.canEditRole(room, 'Hero', 'Actor', false), false);
  assert.equal(presets.canEditPreset(room, { ...preset, createdBy: 'Actor' }, 'Actor', false), false);
  assert.ok(presets.canEditRole(room, 'Hero', 'Host', true));
});

test('role-name creation requires confirmed current binding and role permission before atomic publication', () => {
  const room = scene(), request = create(room), before = structuredClone(room);
  assert.throws(() => catalog.planScene(room, { nick: 'Actor' }, { ...request, roleTargets: undefined }, false), /preset.roleConfirm/);
  assert.throws(() => catalog.planScene(room, { nick: 'Other' }, request, false), /preset.owner/);
  const stale = structuredClone(request); stale.roleTargets[0].revision = 2;
  assert.throws(() => catalog.planScene(room, { nick: 'Actor' }, stale, false), /preset.roleConfirm/);
  assert.deepEqual(room, before);
  const next = catalog.planScene(room, { nick: 'Actor' }, request, false);
  assert.equal(next.roleEffects.Hero.voicePresetId, 'hero-preset');
  assert.equal(next.voicePresets['hero-preset'].name, 'Hero');
  assert.deepEqual(chain.resolve(next.lines[0], next).effects, [effect()]);
  assert.deepEqual(room, before);
  assert.throws(() => catalog.planScene(next, { nick: 'Actor' }, { ...create(next), id: 'duplicate' }, false), /preset.roleExists/);
});

test('role Apply creates and updates one named preset without changing a borrowed source preset', () => {
  const room = scene();
  room.voicePresets.borrowed = { id: 'borrowed', name: 'Radio', revision: 1, createdBy: 'Host', effects: [effect()] };
  const borrowed = structuredClone(room.voicePresets.borrowed), settings = { pitch: 0, effects: [], voicePresetId: 'borrowed', usePresetPitch: false, presetModified: false };
  const request = { scope: 'role', character: 'Hero', revision: 0, presetRevision: 1, settings, rolePreset: { id: 'auto-hero', revision: 0 } };
  const next = voices.plan(room, { nick: 'Actor' }, request, false, () => 'Actor');
  assert.equal(next.voicePresets['auto-hero'].name, 'Hero'); assert.equal(next.roles.Hero.voicePresetId, 'auto-hero');
  const updatedRoom = { ...room, roleEffects: next.roles, voicePresets: next.voicePresets };
  const updated = voices.plan(updatedRoom, { nick: 'Actor' }, { ...request, revision: 1, previousPresetRevision: 1, settings: { ...settings, presetModified: true, effects: [{ ...effect(), amount: .3 }] }, rolePreset: { id: 'auto-hero', revision: 1 } }, false, () => 'Actor');
  assert.equal(updated.voicePresets['auto-hero'].revision, 2); assert.equal(Object.keys(updated.voicePresets).length, 2);
  assert.equal(updated.voicePresets['auto-hero'].effects[0].amount, .3);
  assert.deepEqual(updated.voicePresets.borrowed, borrowed);
  assert.deepEqual(room.voicePresets.borrowed, borrowed);
  assert.throws(() => voices.plan(updatedRoom, { nick: 'Actor' }, request, false, () => 'Actor'), /fx.conflict/);
  assert.throws(() => voices.plan({ ...updatedRoom, characterClaims: {} }, { nick: 'Actor' }, request, false, () => 'Actor'), /fx.owner/);
});
