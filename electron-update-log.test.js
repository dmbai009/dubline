const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {UpdateLog}=require('./electron-update-log');
test('application update log is bounded, persistent and excludes credentials and filesystem paths',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'dubline-update-log-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const log=new UpdateLog(folder,{channel:'github-portable',version:'1.4.0'});
  for(let i=0;i<150;i++)log.record({state:i%2?'downloading':'checking',version:'1.4.1',downloadKind:'patch',progress:{transferred:i},pin:'secret-pin',path:'C:/private-project',error:'token=secret-token'});
  log.record({state:'downloaded',version:'1.4.1'});await log.job;
  const bytes=fs.readFileSync(log.file,'utf8'),saved=JSON.parse(bytes);assert.equal(saved.events.length,128);
  assert.ok(Buffer.byteLength(bytes)<256*1024);assert.equal(saved.events.at(-1).integrity,'verified');
  assert.ok(!/secret|private-project/.test(bytes));assert.equal(new UpdateLog(folder,log.distribution).events.length,127);
});
