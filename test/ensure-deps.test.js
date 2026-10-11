const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto');

test('the dependency marker matches the installed lockfile so the next start does not reinstall', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'dubline-deps-marker-'));
  t.after(()=> { assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep)); fs.rmSync(root,{recursive:true,force:true}); });
  fs.writeFileSync(path.join(root,'package.json'),'{}');
  fs.writeFileSync(path.join(root,'package-lock.json'),'before install');
  const source=fs.readFileSync('tools/ensure-deps.js','utf8');
  let installations=0;
  const run=()=> {
    const complete=Symbol('complete');
    try {
      vm.runInNewContext(source,{__dirname:path.join(root,'tools'),console:{log(){},error(){}},process:{platform:process.platform,exit(code){assert.equal(code,0);throw complete;}},require(name){
        if(name==='child_process')return {spawnSync(){installations++;fs.writeFileSync(path.join(root,'package-lock.json'),'after install');fs.mkdirSync(path.join(root,'node_modules','express'),{recursive:true});return {status:0};}};
        return require(name);
      }});
    } catch(error) { if(error!==complete)throw error; }
  };
  run();
  const hash=crypto.createHash('sha256');
  for(const name of ['package.json','package-lock.json'])hash.update(fs.readFileSync(path.join(root,name)));
  assert.equal(fs.readFileSync(path.join(root,'node_modules','.dubline-deps'),'utf8'),hash.digest('hex'));
  run();assert.equal(installations,1,'the installed dependencies are reused on the next launch');
});
