// Playwright checks against isolated fixtures and mocked preload boundaries.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {startServer,launchBrowser,openPlayer,loadFixture}=require('../e2e/helpers');
const {chromium}=process.env.DUBLINE_PLAYWRIGHT_ROOT?require(path.join(process.env.DUBLINE_PLAYWRIGHT_ROOT,'node_modules','playwright-core')):require(require.resolve('playwright-core',{paths:[process.cwd(),path.resolve('audit/fx-tools')]}));
async function main(){
 let server,browser,pw,shots=0;const out=path.resolve('audit/custom-tunnel');fs.mkdirSync(out,{recursive:true});
 try{
  server=await startServer();browser=await launchBrowser(server.port);
  const setup=await openPlayer(browser,server.url('custom-guide'),'Host',{autoConfirm:false});await loadFixture(setup);
  await setup.evaluate(async port=>{
   window.dublineDesktop={getStatus:async()=>({mode:'custom',state:'manual',port,room:currentRoom,pin:'7K9A',connections:{custom:{state:'manual',publicUrl:''},cloudflare:{state:'idle',enabled:false,publicUrl:''},porthole:{state:'waitingGuest',publicUrl:'http://localhost:'+port},vpn:{state:'waitingGuest',publicUrl:''}}}),copyText:async value=>{window.qaClipboard=value;},onTunnelStatus:()=>()=>{}};
   await initDesktopInvite();
  },server.port);
  const launcherSetup=await browser.newPage();await launcherSetup.evaluateOnNewDocument(()=>{
   window.dublineLauncher={detectTools:async()=>({porthole:{},radmin:{},hamachi:{}}),setLanguage:async()=>{},startHost:async()=>({ok:true}),startSingle:async()=>({ok:true}),openProjectFile:async()=>({ok:true}),joinGuest:async()=>({ok:true}),openNetworkTool:async()=>{throw Error('Must not launch a tool in Custom mode');}};
  });await launcherSetup.goto(pathToFileURL(path.resolve('src/electron-launcher.html')).href);
  pw=await chromium.connectOverCDP(browser.wsEndpoint());const pages=pw.contexts().flatMap(c=>c.pages()),page=pages.find(p=>p.url()===setup.url()),launcher=pages.find(p=>p.url()===launcherSetup.url());
  for(const width of [900,1080])for(const language of ['en','ru','uk']){
   await launcher.setViewportSize({width,height:800});await launcher.locator('#language').selectOption(language);await launcher.locator('[data-mode=custom]').click();
   const geometry=await launcher.locator('#modes').evaluate(node=>({overflow:node.scrollWidth>node.clientWidth+1,cards:[...node.children].map(n=>{const r=n.getBoundingClientRect();return{left:r.left,right:r.right,scroll:n.scrollWidth,client:n.clientWidth};}),width:innerWidth}));
   assert.ok(!geometry.overflow&&geometry.cards.length===4&&geometry.cards.every(r=>r.left>=0&&r.right<=geometry.width&&r.scroll<=r.client+1),JSON.stringify(geometry));
   await launcher.screenshot({path:path.join(out,`launcher-${width}-${language}.png`),fullPage:true});shots++;
  }
  for(const width of [900,1280])for(const zoom of [1,1.5])for(const theme of ['midnight','graphite','light','ocean','forest','sunset'])for(const language of ['en','ru','uk']){
   // Electron page zoom reduces the CSS viewport; body zoom has different vh semantics.
   await page.setViewportSize({width:Math.round(width/zoom),height:Math.round(800/zoom)});await page.evaluate(async({theme,language})=>{closeHostingModal();closeDesktopInvite(false);document.body.style.zoom='';document.documentElement.dataset.theme=theme;await DublineI18n.setLanguage(language);selectDesktopInviteMode('custom');openHostingModal();},{theme,language});
   const modal=page.locator('#hostingModal .modal-card');
   const geometry=await modal.evaluate(node=>{const r=node.getBoundingClientRect();return{fits:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,overflow:node.scrollWidth>node.clientWidth+1,modeButtons:node.querySelectorAll('[data-hosting-mode]').length};});
   assert.ok(geometry.fits&&!geometry.overflow&&geometry.modeButtons===4,JSON.stringify({width,zoom,theme,language,geometry}));
   assert.equal(await page.locator('#desktopCopyPortBtn').isEnabled(),true);await modal.screenshot({path:path.join(out,`settings-${width}-${zoom}-${theme}-${language}.png`)});shots++;
   await page.evaluate(()=>{closeHostingModal();toggleDesktopInvitePanel();});
   const pop=page.locator('#desktopInvitePopover');
   const popup=await pop.evaluate(node=>{const r=node.getBoundingClientRect();return{fits:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1,overflow:node.scrollWidth>node.clientWidth+1,steps:node.querySelector('#desktopCustomInstructions').children.length,pin:document.getElementById('desktopPinCode').textContent};});
   assert.ok(popup.fits&&!popup.overflow&&popup.steps===3&&popup.pin==='••••',JSON.stringify({width,zoom,theme,language,popup}));
   await pop.screenshot({path:path.join(out,`popup-${width}-${zoom}-${theme}-${language}.png`)});shots++;
  }
  assert.deepEqual(setup.errors,[]);console.log(JSON.stringify({screenshots:shots,output:out}));
 }finally{await pw?.close();await browser?.close();await server?.cleanup();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
