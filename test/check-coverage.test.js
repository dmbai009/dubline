const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');

test('syntax checking discovers new owned scripts while excluding vendor and user media', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'dubline-check-coverage-'));
  t.after(()=> { assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep)); fs.rmSync(root,{recursive:true,force:true}); });
  const write = (file,source) => { const target=path.join(root,file); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,source); };
  for (const file of ['entry.js','src/electron-main.js','src/server/sockets/editor.js','src/public/widget.js','src/public/locale/en.js','test/new.test.js','e2e/new.e2e.js','tools/new-tool.js']) write(file,'const ready = true;');
  for (const file of ['src/public/vendor/library.js','src/public/uploads/user.js','src/public/packs/archive.js']) write(file,'invalid syntax !');
  const source = fs.readFileSync('tools/check.js','utf8');
  const run = () => {
    let status=0,stderr='';
    vm.runInNewContext(source,{__dirname:path.join(root,'tools'),require(name){
      if(name==='fs')return {...fs,readdirSync(directory,options){
        assert.ok(!/^src[\\/]public[\\/](?:vendor|uploads|packs)(?:[\\/]|$)/.test(path.relative(root,directory)),'external directories must not even be traversed');
        return fs.readdirSync(directory,options);
      }};
      return require(name);
    },process:{execPath:process.execPath,stderr:{write(text){stderr+=text;}},exit(code){status=code;}}});
    return {status,stderr};
  };
  assert.deepEqual(run(),{status:0,stderr:''});
  write('src/new-entry.js','const broken = ;');
  assert.equal(run().status,1,'new source entry points are checked without a manual list');
  write('src/new-entry.js','const restored = true;');
  write('e2e/new-unlisted.e2e.js','const broken = ;');
  const failed=run(); assert.equal(failed.status,1); assert.match(failed.stderr,/new-unlisted\.e2e\.js/);
  write('e2e/new-unlisted.e2e.js','const restored = true;');
  assert.deepEqual(run(),{status:0,stderr:''});
});
