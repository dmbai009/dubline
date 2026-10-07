const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { saveProjectFile } = require('./server/project-save'), { readProject } = require('./server/projects');
const { fixtureVideoPath } = require('./e2e/helpers');
test('native save validates staging and atomically replaces Unicode destination; failure preserves previous bytes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-save-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'Проєкт Юнікод.dubline'), scene = { loaded: true, title: 'Snapshot', kind: 'custom', mode: 'edit', videoUrl: 'video', trackOrder: ['Role'], lines: [{ id: 1, character: 'Role', caption: 'Captured caption', start: 1, end: 2 }], audioTracks: [] };
  const options = { resolveAsset: () => fixtureVideoPath() };
  fs.writeFileSync(target, 'previous project');
  const abort = new AbortController();
  await assert.rejects(saveProjectFile(scene, target, { ...options, signal: abort.signal, beforeCommit: () => abort.abort() }), /abort/i);
  assert.equal(fs.readFileSync(target, 'utf8'), 'previous project');
  await assert.rejects(saveProjectFile(scene, target, { ...options, beforeCommit: () => { throw Error('Injected failure before rename'); } }), /Injected/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'previous project');
  const saved = await saveProjectFile(scene, target, options);
  assert.equal(saved.filename, path.basename(target)); assert.equal(saved.bytes, fs.statSync(target).size);
  assert.equal(readProject(fs.readFileSync(target)).manifest.project.lines[0].caption, 'Captured caption');
  assert.deepEqual(fs.readdirSync(dir), [path.basename(target)]);
});
test('native save refuses a destination changed by another writer and preserves that writer', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-save-race-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'race.dubline'); fs.writeFileSync(target, 'old');
  const scene = { loaded: true, title: 'Snapshot', kind: 'custom', mode: 'edit', videoUrl: 'video', trackOrder: [], lines: [], audioTracks: [] };
  await assert.rejects(saveProjectFile(scene, target, { resolveAsset: () => fixtureVideoPath(), beforeCommit: () => fs.writeFileSync(target, 'new external writer') }), /destination changed/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new external writer'); assert.deepEqual(fs.readdirSync(dir), ['race.dubline']);
});
test('native save reports real bytes and allows pre-commit cancellation without touching the destination',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dubline-save-progress-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const target=path.join(dir,'scene.dubline');fs.writeFileSync(target,'preserved destination');
  const scene={loaded:true,title:'Snapshot',kind:'custom',mode:'edit',videoUrl:'video',trackOrder:[],lines:[],audioTracks:[]};
  const controller=new AbortController(), canceled=[];
  await assert.rejects(saveProjectFile(scene,target,{resolveAsset:()=>fixtureVideoPath(),signal:controller.signal,onProgress:progress=>{canceled.push(progress);if(progress.stage==='writing'&&progress.bytes>0)controller.abort();}}),/abort/i);
  assert.equal(fs.readFileSync(target,'utf8'),'preserved destination');assert.ok(!canceled.some(progress=>progress.stage==='committing'));
  const phases=[];const saved=await saveProjectFile(scene,target,{resolveAsset:()=>fixtureVideoPath(),onProgress:progress=>phases.push(progress)});
  assert.deepEqual([...new Set(phases.map(progress=>progress.stage))],['preparing','writing','finalizing','committing']);
  assert.equal(phases.filter(progress=>progress.stage==='writing').at(-1).bytes,saved.bytes);
  assert.ok(phases.every(progress=>Object.keys(progress).sort().join(',')==='bytes,stage'),'progress contains no filesystem paths');
  assert.deepEqual(fs.readdirSync(dir),['scene.dubline']);
});
