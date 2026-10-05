const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { skipReason, launchBrowser, waitFor } = require('./helpers');
describe('storage launcher controls', {skip:skipReason}, () => {
  let browser, page;
  before(async () => {
    browser = await launchBrowser(0); page = await browser.newPage();
    await page.setViewport({width:1080,height:780});
    await page.evaluateOnNewDocument(() => {
      window.__storage = {root:'C:/AppData/Dubline',pending:''};
      window.__storagePicker = 'move'; window.__hostFails = false;
      window.dublineLauncher = {
        language:'en',setLanguage:async()=>true,
        detectTools:async()=>({}),getStorage:async()=>window.__storage,
        onStorageProgress:callback=>{window.__storageProgress=callback;},
        chooseStorage:async()=>{
          if(window.__storagePicker==='cancel')return {ok:true,canceled:true,...window.__storage};
          if(window.__storagePicker==='occupied')return {ok:false,code:'occupied',...window.__storage};
          window.__storageProgress({completed:50*1048576,total:300*1048576});
          await new Promise(resolve=>{window.__finishStorage=resolve;});
          window.__storage={root:'D:/Projects/Dubline',pending:''};return {ok:true,...window.__storage};
        },
        startHost:async()=>window.__hostFails ? {ok:false,error:'Drive unavailable',storageCode:'missing'} : {ok:true},
        startSingle:async()=>({ok:true}),openProjectFile:async()=>({ok:true}),joinGuest:async()=>({ok:true})
      };
    });
    await page.goto(pathToFileURL(path.resolve('electron-launcher.html')).href,{waitUntil:'domcontentloaded'});
    await waitFor(page,()=>document.getElementById('storagePath').textContent.includes('AppData'));
  });
  after(async()=>{if(browser)await browser.close();});
  test('folder selection displays disk-copy progress, locks startup and publishes the completed path', async()=>{
    await page.click('#storageChange');
    await waitFor(page,()=>document.getElementById('storageStatus').textContent.includes('50.0 / 300.0'));
    for(const id of ['storageChange','startSingle','openProjectFile','startHost','joinGuest'])assert.equal(await page.$eval('#'+id,node=>node.disabled),true,id);
    await page.evaluate(()=>window.__finishStorage());
    await waitFor(page,()=>document.getElementById('storagePath').textContent.includes('D:/Projects')&&!document.getElementById('storageChange').disabled);
    assert.equal(await page.$eval('#storageStatus',node=>node.textContent),'');
  });
  test('cancel and occupied destination retain existing path and restore controls',async()=>{
    await page.evaluate(()=>window.__storagePicker='cancel');await page.click('#storageChange');
    await waitFor(page,()=>!document.getElementById('storageChange').disabled);
    assert.equal(await page.$eval('#storagePath',node=>node.textContent),'D:/Projects/Dubline');
    await page.evaluate(()=>window.__storagePicker='occupied');await page.click('#storageChange');
    await waitFor(page,()=>document.getElementById('storageStatus').textContent.includes('must be empty'));
    assert.equal(await page.$eval('#startHost',node=>node.disabled),false);
    assert.equal(await page.$eval('#storagePath',node=>node.textContent),'D:/Projects/Dubline');
  });
  test('unavailable drive at host startup shows a localized error and allows a retry',async()=>{
    await page.evaluate(()=>window.__hostFails=true);await page.click('#startHost');
    await waitFor(page,()=>document.getElementById('hostError').textContent.includes('Connect the drive'));
    assert.equal(await page.$eval('#startHost',node=>node.disabled),false);
    await page.evaluate(()=>window.__hostFails=false);await page.click('#startHost');
    assert.equal(await page.$eval('#hostError',node=>node.textContent),'');
  });
  test('storage folder/help and pending path translate in EN/RU/UK',async()=>{
    await page.evaluate(()=>{window.__storage.pending='E:/Dubline';});
    for(const [code,text] of [['en','After restart'],['ru','После перезапуска'],['uk','Після перезапуску']]){
      await page.select('#language',code);await page.evaluate(()=>refreshStorage());
      assert.ok((await page.$eval('#storagePending',node=>node.textContent)).startsWith(text));
      assert.ok((await page.$eval('[data-t="storage.help"]',node=>node.textContent)).length>50);
    }
  });
});
