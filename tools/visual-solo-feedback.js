const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {startServer,launchBrowser,openPlayer,waitFor,buildMultiTrackVideo}=require('../e2e/helpers');
(async()=>{let server,browser;try{
 server=await startServer({DUBLINE_DESKTOP_ROOM:'main',DUBLINE_DESKTOP_HOST_TOKEN:'solo-visual',DUBLINE_ROOM_PIN:'ABCD',DUBLINE_SINGLE_PLAYER:'1'});
 browser=await launchBrowser(server.port);const page=await openPlayer(browser,server.url('main')+'&desktopHost=solo-visual&workspace=single','Solo',{audioExpanded:true});
 await page.setViewport({width:2560,height:1440,deviceScaleFactor:1});
 await page.evaluate(()=>openFilesModal());await(await page.$('#customVideoInput')).uploadFile(buildMultiTrackVideo());await page.evaluate(()=>uploadCustomScene());
 await waitFor(page,()=>session.audioTracks?.length===2&&video.readyState>=3);await page.evaluate(()=>{closeFilesModal();setTimelineZoom((timelineContainer.clientWidth-labelWidth-40)/video.duration,0);});
 await waitFor(page,()=>document.querySelector('[data-audio-channel=original] .studio-wave-status').textContent==='');
 assert.equal(await page.$eval('#trackPicker',node=>node.parentElement.classList.contains('video-box')),true);
 const directory=path.join(__dirname,'../docs/qa');fs.mkdirSync(directory,{recursive:true});
 await page.screenshot({path:path.join(directory,'1.4-solo-qhd-audio.png')});
 console.log('QHD screenshot with actual two-track waveform and fixed picker saved.');
}finally{await browser?.close();await server?.cleanup();}})().catch(e=>{console.error(e);process.exitCode=1;});
