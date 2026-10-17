const { test } = require('node:test'), assert = require('node:assert/strict');
const chain = require('../src/public/voice-chain-model'), presets = require('../src/public/voice-preset-model'), voices = require('../src/server/voiceChains');
const eq = gains => ({ id: 'eq', type: 'equalizer', enabled: true, amount: 1, parameters: { gains } });
test('five-band equalizer validates finite gain ranges, participates in ordering and bypasses a flat curve', () => {
  const flat = eq([0, 0, 0, 0, 0]); assert.equal(chain.TYPES.at(-1), 'equalizer'); assert.equal(chain.TYPES.length, 11);
  assert.ok(chain.validEffects([flat])); assert.deepEqual(chain.active([flat]), []);
  for (const gains of [[], [0,0,0,0], [0,0,0,0,13], [0,0,NaN,0,0], [0,0,Infinity,0,0], ['0',0,0,0,0]]) assert.equal(chain.validEffects([eq(gains)]), false);
  assert.equal(chain.validEffects([{ ...flat, parameters: { gains: [0,0,0,0,0], extra: true } }]), false);
  assert.equal(chain.validEffects([{ ...flat, amount: .5 }]), false);
  const active = eq([-12, 2.5, 0, -1, 12]); assert.deepEqual(chain.active([active]), [active]); assert.equal(chain.tail(active), 0);
  assert.equal(voices.minimumVersion({ lines: [{ effects: [active] }] }), 5);
  assert.equal(chain.hasPitchStage({ deletedLines: [{ lines: [{ line: { takeHistory: [{ effects: [active] }] } }] }] }, 'equalizer'), true);
});
test('legacy role preset isolation keeps current, archived, trash and inherited audio identical', () => {
  const radio = { id: 'radio', type: 'radio', enabled: true, amount: .5, parameters: {} };
  const entry = { voicePresetId: 'shared', usePresetPitch: true, effects: [], pitch: 7, pitchMode: 'inherit', presetModified: false };
  const scene = { trackOrder: ['Hero', 'Friend'], voicePresets: { shared: { id: 'shared', name: 'Hero', revision: 1, createdBy: 'Host', effects: [radio], pitch: -2 } }, roleEffects: { Hero: { ...entry, revision: 1 }, Friend: { ...entry, revision: 1 } }, lines: [{ id: 1, character: 'Hero', ...entry, takeHistory: [{ ...entry }] }, { id: 2, character: 'Friend', ...entry, usePresetPitch: false }], deletedLines: [{ lines: [{ line: { id: 3, character: 'Hero', ...entry } }] }] };
  const configurations = () => [...scene.lines.flatMap(line => [line, ...(line.takeHistory || []).map(take => ({ ...take, character: line.character }))]), scene.deletedLines[0].lines[0].line].map(line => chain.resolve(line, scene));
  const before = configurations(); assert.ok(presets.migrateScene(scene)); assert.deepEqual(configurations(), before);
  assert.equal(scene.voicePresets.shared.role, 'Hero'); assert.equal(scene.roleEffects.Friend.voicePresetId, null);
  assert.ok(scene.lines.every(line => line.voicePresetId === null)); assert.equal(scene.lines[0].pitchMode, 'override');
  assert.equal(presets.migrateScene(scene), false);
  scene.voicePresets.shared.effects[0].amount = .1;
  assert.equal(scene.lines[0].effects[0].amount, .5); assert.equal(scene.roleEffects.Friend.effects[0].amount, .5);
  assert.throws(() => presets.link(scene.lines[0], scene, 'shared'), /preset.invalid/);
  assert.throws(() => presets.apply(scene.lines[0], scene, scene.voicePresets.shared, { newId: () => 'copy' }), /preset.invalid/);
});
test('a newly created or renamed role cannot take ownership of an existing take preset', () => {
  const scene = { trackOrder: ['Hero'], roleEffects: {}, voicePresets: { regular: { id: 'regular', name: 'Hero', revision: 1, createdBy: 'Actor', effects: [] }, other: { id: 'other', name: 'Hero (preset)', revision: 1, createdBy: 'Actor', effects: [] } } };
  assert.ok(presets.reconcileNames(scene)); assert.equal(scene.voicePresets.regular.name, 'Hero (preset 2)'); assert.equal(scene.voicePresets.regular.role, undefined);
  assert.equal(presets.rolePreset(scene, 'Hero'), null); assert.equal(presets.reconcileNames(scene), false);
  assert.ok(presets.canEditPreset({ ...scene, characterClaims: { Hero: 'Other' } }, scene.voicePresets.regular, 'Actor', false));
});
test('legacy generic preset borrowing is snapshotted for roles without changing audio or sharing future updates',()=>{
  const radio={id:'radio',type:'radio',enabled:true,amount:.5,parameters:{}},preset={id:'generic',name:'Radio',revision:1,createdBy:'Host',effects:[radio],pitch:-3};
  const scene={trackOrder:['Hero'],characterClaims:{},voicePresets:{generic:preset},roleEffects:{Hero:{voicePresetId:'generic',usePresetPitch:true,effects:[],pitch:0,revision:0}},lines:[{id:1,character:'Hero',pitchMode:'inherit'}]};
  const before=chain.resolve(scene.lines[0],scene);assert.ok(presets.migrateScene(scene));assert.deepEqual(chain.resolve(scene.lines[0],scene),before);assert.equal(scene.roleEffects.Hero.voicePresetId,null);
  const next=voices.plan({...scene,roleEffects:{}},{nick:'Host'},{scope:'role',character:'Hero',revision:0,presetRevision:1,settings:{voicePresetId:'generic',usePresetPitch:true,effects:[],pitch:0}},true,()=> 'Host');
  assert.equal(next.roles.Hero.voicePresetId,null);assert.equal(next.roles.Hero.pitch,-3);preset.effects[0].amount=.1;assert.equal(scene.roleEffects.Hero.effects[0].amount,.5);assert.equal(next.roles.Hero.effects[0].amount,.5);
});
test('missing prototype-like preset IDs never resolve inherited object properties during migration',()=>{
  const scene={voicePresets:{},roleEffects:{Object:{voicePresetId:'constructor',effects:[],pitch:0}},lines:[],trackOrder:['Object']};
  assert.equal(presets.migrateScene(scene),false);assert.equal(Object.role,undefined);assert.deepEqual(scene.voicePresets,{});
});
