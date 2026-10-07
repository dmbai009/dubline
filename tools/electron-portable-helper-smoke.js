const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {createManifest,manifestBytes,bytesHash,changesBetween,verifyTree}=require('../electron-managed-files');
if(process.versions.electron){
  const {app}=require('electron');
  app.whenReady().then(async()=>{
    const {PortableUpdater}=require('../electron-portable-update');
    const file=process.env.DUBLINE_HELPER_QA_JOB;
    const adapter=new PortableUpdater({current:{version:'1.4.0'},root:path.dirname(file),exit:()=>app.exit(0)});
    await adapter.startHelper(file,path.resolve(__dirname,'../resources/portable-update-helper.ps1'));
  }).catch(error=>{console.error(error);app.exit(1);});
}else{
  (async()=>{
    const folder=await fsp.mkdtemp(path.join(os.tmpdir(),'dubline-helper-console-'));
    try{
      async function tree(name,version){
        const root=path.join(folder,name);await fsp.mkdir(path.join(root,'resources'),{recursive:true});
        const marker={schemaVersion:1,channel:'github-portable',version,commit:'a'.repeat(40),electronVersion:require('electron/package.json').version,platform:'win32',arch:'x64'};
        await fsp.writeFile(path.join(root,'Dubline.exe'),'dummy-unchanged-runtime');
        await fsp.writeFile(path.join(root,'resources','app.asar'),'code '+version);
        await fsp.writeFile(path.join(root,'resources','dubline-distribution.json'),JSON.stringify(marker));
        const manifest=await createManifest(root,marker);await fsp.writeFile(path.join(root,'resources','dubline-managed.json'),manifestBytes(manifest));return {root,manifest};
      }
      const base=await tree('A','1.4.0'),target=await tree('B','1.4.1'),changes=changesBetween(base.manifest,target.manifest);
      const job=path.join(folder,'job.json'),plan={schemaVersion:1,root:base.root,staged:target.root,base:base.manifest,target:target.manifest,baseManifestHash:bytesHash(manifestBytes(base.manifest)),targetManifestHash:bytesHash(manifestBytes(target.manifest)),full:false,changed:changes.changed.map(file=>file.path),removed:changes.removed,restart:false,processes:[]};
      const env={...process.env,DUBLINE_HELPER_QA_JOB:job};delete env.ELECTRON_RUN_AS_NODE;
      const child=spawn(require('electron'),[__filename,'--disable-gpu'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let log='';child.stderr.on('data',data=>{log+=data;});
      plan.processes=[{id:child.pid}];await fsp.writeFile(job,JSON.stringify(plan));
      assert.equal(await new Promise(resolve=>child.once('exit',resolve)),0,log);
      const deadline=Date.now()+30000;let result;
      while(Date.now()<deadline){try{result=JSON.parse(await fsp.readFile(path.join(folder,'update-result.json'),'utf8'));break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
      assert.equal(result?.ok,true,JSON.stringify(result));await verifyTree(base.root,target.manifest);
      console.log('External Portable helper survives Electron shutdown and commits verified managed files.');
    }finally{await fsp.rm(folder,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
  })().catch(error=>{console.error(error);process.exitCode=1;});
}
