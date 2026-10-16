// Playwright visual/geometry checks use only an isolated generated scene.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { startServer, launchBrowser, openPlayer, loadFixture } = require('../e2e/helpers');
const { chromium } = process.env.DUBLINE_PLAYWRIGHT_ROOT ? require(path.join(process.env.DUBLINE_PLAYWRIGHT_ROOT,'node_modules','playwright-core')) : require('playwright-core');
async function main() {
  let server,browser,pw,shots=0; const out=path.resolve('audit/equalizer-role');fs.mkdirSync(out,{recursive:true});
  try {
    server=await startServer();browser=await launchBrowser(server.port);const setup=await openPlayer(browser,server.url('eq-qa'),'Host',{autoConfirm:false,audioExpanded:false});await loadFixture(setup);
    pw=await chromium.connectOverCDP(browser.wsEndpoint());const page=pw.contexts().flatMap(c=>c.pages()).find(p=>p.url()===setup.url());
    await page.evaluate(()=>DublineVoiceEditor.open('Hero','role'));
    const shot=async(name,selector='#fxDialog')=>{await page.locator(selector).screenshot({path:path.join(out,name+'.png'),animations:'disabled'});shots++;};
    const geometry=async()=>page.evaluate(()=>{const dialog=document.getElementById('fxDialog'),r=dialog.getBoundingClientRect(),cards=[...document.querySelectorAll('#fxRows .fx-item')].map(n=>n.getBoundingClientRect());return{fits:r.left>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,overflow:dialog.scrollWidth>dialog.clientWidth+1,columns:cards.length<4||cards.slice(0,4).every(c=>Math.abs(c.y-cards[0].y)<1),bands:document.querySelectorAll('[data-action=eqGain]').length,cardOverflow:[...document.querySelectorAll('#fxRows .fx-item')].some(n=>{const r=n.getBoundingClientRect();return [...n.querySelectorAll("button,input,output,b")].some(c=>{const b=c.getBoundingClientRect();return b.width&&(b.left<r.left-1||b.right>r.right+1);});})};});
    for(const count of [1,4,8]) {
      if(await page.locator('#fxClearChain').isEnabled())await page.locator('#fxClearChain').click();
      for(const type of ['equalizer','pitch','radio','telephone','echo','behindDoor','megaphone','robot'].slice(0,count))await page.locator(`[data-fx-type=${type}]`).click();
      await page.locator('[data-action=eqGain][data-band="0"]').evaluate(n=>{n.value='6';n.dispatchEvent(new Event('input',{bubbles:true}));});
      for(const theme of ['midnight','graphite','light','ocean','forest','sunset'])for(const language of ['en','ru','uk']){
        await page.setViewportSize({width:1280,height:800});await page.evaluate(async({theme,language})=>{document.body.style.zoom='';document.documentElement.dataset.theme=theme;await DublineI18n.setLanguage(language);},{theme,language});await page.waitForTimeout(40);
        const g=await geometry();if(g.cardOverflow){await shot('overflow');console.log(await page.locator('#fxRows .fx-item').evaluateAll(nodes=>nodes.map(n=>({width:n.clientWidth,scroll:n.scrollWidth,html:n.textContent}))));}assert.ok(g.fits&&!g.overflow&&g.columns&&!g.cardOverflow&&g.bands===5,JSON.stringify({count,theme,language,g}));assert.ok(await page.locator('#fxLinked').isHidden());assert.ok(await page.locator('#fxPresetSave').isHidden());
        await shot(`${count}-${theme}-${language}`);
      }
    }
    for(const width of [640,900])for(const zoom of [1,1.5]){
      await page.setViewportSize({width,height:800});await page.evaluate(zoom=>{document.body.style.zoom=String(zoom);},zoom);await page.waitForTimeout(60);const g=await geometry();assert.ok(g.fits&&!g.overflow&&!g.cardOverflow,JSON.stringify({width,zoom,g}));await shot(`narrow-${width}-${zoom}`);
    }
    await page.setViewportSize({width:1600,height:900});
    for(const zoom of [1,1.5]){
      await page.evaluate(zoom=>{document.body.style.zoom=String(zoom);},zoom);await page.locator('#fxClearChain').click();await page.locator('[data-fx-type=telephone]').click();
      await page.locator('[data-fx-type=equalizer]').scrollIntoViewIfNeeded();
      const start=await page.locator('[data-fx-type=equalizer]').boundingBox(),body=await page.locator('#fxDialog .fx-body').boundingBox();
      await page.mouse.move(start.x+start.width/2,start.y+start.height/2);await page.mouse.down();await page.mouse.move(body.x+body.width*.25,body.y+10,{steps:15});
      await page.waitForFunction(()=>document.querySelector('#fxDialog .fx-body').scrollTop<=1);
      const target=await page.locator('#fxRows .fx-item').boundingBox();
      const x=target.x+target.width*.25,y=target.y+target.height*.5;
      await page.mouse.move(x,y,{steps:15});
      const ghost=await page.locator('.fx-drag-ghost').boundingBox();assert.ok(ghost&&Math.abs(ghost.x-(x-40))<20&&Math.abs(ghost.y-(y-18))<20,JSON.stringify({zoom,x,y,ghost}));
      await shot(`palette-drag-${zoom}`);await page.mouse.up();assert.deepEqual(await page.evaluate(()=>DublineVoiceEditor.draft().effects.map(e=>e.type)),['equalizer','telephone']);
    }
    await page.evaluate(()=>{document.body.style.zoom='';});await page.locator('[data-action=eqGain][data-band="0"]').evaluate(n=>{n.value='6';n.dispatchEvent(new Event('input',{bubbles:true}));});await page.locator('#fxApply').click();await page.waitForFunction(()=>!fxDialog.open);
    await page.evaluate(()=>DublineVoiceEditor.open(1,'takes'));await page.locator('[data-fx-type=equalizer]').click();assert.ok(await page.locator('.fx-flow-role').isVisible());await shot('take-inherited-role');await page.evaluate(()=>DublineVoiceEditor.close(true));
    await page.evaluate(()=>socket.emit('set_session_mode',{mode:'edit',sessionId:session.activeSessionId}));await page.waitForFunction(()=>session.mode==='edit');
    for(const zoom of [1,1.5]){
      // Exercise the reduced CSS viewport corresponding to desktop page zoom.
      await page.setViewportSize({width:Math.round(1600/zoom),height:Math.round(900/zoom)});
      await page.evaluate(()=>{document.body.style.zoom='';layout.top=Math.round(innerHeight*.4);applyLayout();document.querySelector('.track-row[data-character=Hero]').scrollIntoView({block:'center'});});await page.waitForTimeout(450);
      const start=await page.locator('.track-row[data-character=Hero] .track-drag-handle').boundingBox(),target=await page.locator('.track-row[data-character=Friend]').boundingBox();
      const x=await page.locator('.track-row[data-character=Hero]').evaluate(n=>n.getBoundingClientRect().x);await page.mouse.move(start.x+start.width/2,start.y+start.height/2);await page.mouse.down();await page.mouse.move(start.x+200,target.y+target.height*.75,{steps:15});
      if(!await page.locator('.track-reorder-source').isVisible()){console.log({zoom,start,target,geometry:await page.evaluate(()=>({active:window.activeEditorGesture?.type,view:[innerWidth,innerHeight],timeline:JSON.stringify(timelineContainer.getBoundingClientRect()),hit:document.elementFromPoint(290,420)?.outerHTML.slice(0,200)}))});await page.screenshot({path:path.join(out,'track-failure.png')});}
      assert.ok(await page.locator('.track-reorder-source').isVisible());assert.ok(Math.abs(await page.locator('.track-reorder-source').evaluate(n=>n.getBoundingClientRect().x)-x)<1);await shot(`track-drag-${zoom}`,'#timelineContainer');await page.keyboard.press('Escape');await page.mouse.up();assert.equal(await page.locator('.track-reorder-source').count(),0);
    }
    assert.deepEqual(setup.errors,[]);console.log(JSON.stringify({screenshots:shots,output:out}));
  }finally{await pw?.close();await browser?.close();await server?.cleanup();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
