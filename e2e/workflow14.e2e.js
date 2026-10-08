const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor, waitUntil, answerTextPrompt, recordTake, fixtureVideoPath, buildVoiceFile, buildFixturePack } = require('./helpers');

function parentRequest(server, type, fields = {}) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID(), timer = setTimeout(() => reject(Error('IPC timeout')), 20000);
    const listener = message => { if (message.requestId === requestId) { clearTimeout(timer); server.proc.off('message', listener); message.ok ? resolve(message) : reject(Error(message.error)); } };
    server.proc.on('message', listener); server.proc.send({ type, requestId, ...fields });
  });
}
async function snapshotFile(page, file) {
  const bytes = await page.evaluate(async () => {
    const response = await fetch('/api/export-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...await window.prepareSafeSnapshot('project'),  room: currentRoom, clientId, sessionId: session.activeSessionId }) });
    if (!response.ok) throw Error(await response.text());
    const array = new Uint8Array(await response.arrayBuffer()); let text = '';
    for (let i = 0; i < array.length; i += 32768) text += String.fromCharCode(...array.subarray(i, i + 32768));
    return btoa(text);
  });
  fs.writeFileSync(file, Buffer.from(bytes, 'base64'));
}

describe('1.4 dialogs, settings and bounded timeline', { skip: skipReason, timeout: 90000 }, () => {
  let server, browser, host, guest;
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); host = await openPlayer(browser, server.url('workflow14'), 'Host', { autoConfirm: false, audioExpanded:false }); guest = await openPlayer(browser, server.url('workflow14'), 'Guest'); await loadFixture(host); await waitFor(guest, () => session.loaded); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('text and confirm dialogs center, trap focus, support Enter/Escape, restore focus and localize', async () => {
    await host.evaluate(() => { document.getElementById('editModeBtn').focus(); window.dialogAnswer = undefined; askConfirm('Confirm action').then(value => window.dialogAnswer = value); });
    await waitFor(host, () => document.querySelector('dialog[open]'));
    const box = await host.evaluate(() => { const r = document.querySelector('dialog[open]').getBoundingClientRect(); return { x: (r.left + r.right) / 2 - innerWidth / 2, y: (r.top + r.bottom) / 2 - innerHeight / 2 }; });
    assert.ok(Math.abs(box.x) < 2 && Math.abs(box.y) < 2, JSON.stringify(box));
    for (let i = 0; i < 4; i++) { await host.keyboard.press('Tab'); assert.equal(await host.evaluate(() => !!document.activeElement.closest('dialog')), true); }
    await host.keyboard.press('Escape'); await waitFor(host, () => window.dialogAnswer === false);
    assert.equal(await host.evaluate(() => document.activeElement.id), 'editModeBtn');
    await host.evaluate(() => { askConfirm('Confirm').then(value => window.dialogAnswer = value); }); await host.keyboard.press('Enter'); await waitFor(host, () => window.dialogAnswer === true);
    for (const [language, text] of [['ru', 'Подтвердить'], ['uk', 'Підтвердити'], ['en', 'Confirm']]) {
      await host.evaluate(async language => { await DublineI18n.setLanguage(language); askConfirm('Action'); }, language);
      assert.equal(await host.$eval('#textPromptSave', node => node.textContent), text); await host.keyboard.press('Escape');
    }
    await host.evaluate(() => { askText('Role', 'Old').then(value => window.textAnswer = value); });
    await answerTextPrompt(host, 'New'); assert.equal(await host.evaluate(() => window.textAnswer), 'New');
  });
  test('ADR enabled enforces 3–5 seconds immediately, local volume persists, disabled restores 0–5', async () => {
    await host.evaluate(() => { openSettingsModal(); preRollSeconds = 1; syncSettingsUi(); });
    await host.select('[data-studio-setting=adr]', 'three');
    assert.deepEqual(await host.evaluate(() => [preRollSeconds, document.getElementById('settingsPreRoll').min]), [3, '3']);
    await host.$eval('#settingsPreRoll', node => { node.min = '0'; node.value = '1'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await host.evaluate(() => preRollSeconds), 3);
    await host.$eval('#settingsAdrVolume', node => { node.value = '35'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    await host.reload(); await waitFor(host, () => session?.loaded);
    assert.deepEqual(await host.evaluate(() => [preRollSeconds, adrCueVolume]), [3, 0.35]);
    await host.evaluate(() => openSettingsModal()); await host.select('[data-studio-setting=adr]', 'off');
    await host.$eval('#settingsPreRoll', node => { node.value = '0'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await host.evaluate(() => preRollSeconds), 0); await host.evaluate(() => closeSettingsModal());
  });
  test('personal controls are in My Settings; shared values remain visible and disabled to Dub guests', async () => {
    assert.equal(await guest.$('#projectMixSettings'), null, 'project mix has one home on the timeline');
    assert.equal(await guest.$$eval('.studio-audio-row', rows => rows.length), 3);
    const placements = await guest.evaluate(() => ['settingsLocalDuck', 'settingsPrompter', 'settingsHideMyTakes', 'settingsAdrVolume', 'settingsP2P'].map(id => document.getElementById(id).closest('.tab-content').id));
    assert.ok(placements.every(id => id === 'tabContentUser'));
    await guest.evaluate(() => { openSettingsModal(); switchSettingsTab('player'); });
    assert.equal(await guest.$$eval('[data-audio-field=offset]', controls => controls.length === 2 && controls.every(node => node.disabled)), true);
    assert.equal(await guest.$$eval('[data-audio-field=volume]', controls => controls.length === 3 && controls.every(node => !node.disabled)), true, 'guest monitoring remains usable');
    assert.equal(await guest.$eval('#roomPasswordInput', node => node.disabled), true);
    await host.evaluate(() => setStudioMode('edit')); await waitFor(guest, () => session.mode === 'edit');
    assert.equal(await guest.$$eval('[data-audio-field=offset]', controls => controls.length === 2 && controls.every(node => !node.disabled)), true);
    await guest.evaluate(() => closeSettingsModal());
  });
  test('bounds reject server creates and inspector edits beyond real duration; empty track clicks seek with zoom and scroll', async () => {
    const id = await host.evaluate(() => session.activeSessionId);
    const rejected = await host.evaluate(async () => new Promise(resolve => socket.emit('editor_create_line', { sessionId: session.activeSessionId, character: 'Hero', start: video.duration, end: video.duration + 1 }, resolve)));
    assert.equal(rejected.ok, false);
    await host.evaluate(() => createEditorLineAt('Hero', video.duration + 0.1));
    assert.equal(await host.evaluate(() => session.activeSessionId), id);
    assert.ok(await host.evaluate(() => document.body.textContent.includes(t('timeline.outsideCreate'))));
    await host.evaluate(() => createEditorLineAt('Hero', video.duration - 0.01));
    await waitFor(host, () => selectedLine?.end === video.duration);
    await host.$eval('#editorEnd', node => { node.value = '100'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    await host.click('#editorLineForm button[type=submit]');
    assert.equal(await host.evaluate(() => selectedLine.end <= video.duration), true);
    await host.evaluate(() => { zoomTimeline(3); timelineContainer.scrollLeft = 120; });
    await waitFor(host, () => parseFloat(document.querySelector('.timeline-outside').style.left) === video.duration * pxPerSec);
    await host.evaluate(() => { timelineContainer.scrollLeft = 120; });
    const click = await host.evaluate(() => { const row = document.querySelector('[data-character=Hero] .track-timeline'), r = row.getBoundingClientRect(); return { x:r.left + 5.3 * pxPerSec, y:r.top + 12, p:pxPerSec, boundary: row.querySelector('.timeline-outside').getBoundingClientRect().left - r.left, duration: video.duration }; });
    assert.ok(Math.abs(click.boundary - click.duration * click.p) < 1, JSON.stringify(click));
    await host.mouse.click(click.x, click.y); assert.ok(Math.abs(await host.evaluate(() => video.currentTime) - 5.3) < 0.05, JSON.stringify(await host.evaluate(p => ({p,now:video.currentTime,hit:document.elementFromPoint(p.x,p.y)?.outerHTML.slice(0,200)}),click)));
  });
  test('mixed-track keyboard group movement is relative and atomic; Undo restores the group', async () => {
    await loadFixture(host); await host.evaluate(() => setStudioMode('edit')); await waitFor(host, () => session.mode === 'edit');
    await host.evaluate(async () => { await queueEditorRequest(() => ['editor_add_track', { character: 'Third' }]); multiSelection.clear(); multiSelection.add(1); multiSelection.add(2); });
    const before = await host.evaluate(() => session.lines.filter(line => multiSelection.has(line.id)).map(line => ({ id: line.id, character: line.character, start: line.start })));
    await host.evaluate(() => handleEditorKey({ code:'ArrowUp', altKey:true, preventDefault() {} }));
    assert.deepEqual(await host.evaluate(() => session.lines.filter(line => multiSelection.has(line.id)).map(line => ({ id: line.id, character: line.character, start: line.start }))), before);
    await host.evaluate(() => handleEditorKey({ code:'ArrowDown', altKey:true, preventDefault() {} }));
    await waitFor(host, () => session.lines.find(line => line.id === 1).character !== 'Hero');
    assert.deepEqual(await host.evaluate(() => session.lines.filter(line => multiSelection.has(line.id)).map(line => line.character)), ['Friend', 'Third']);
    await host.evaluate(() => editorUndo()); await waitFor(host, () => session.lines.find(line => line.id === 1).character === 'Hero');
    assert.deepEqual(await host.evaluate(() => session.lines.filter(line => multiSelection.has(line.id)).map(line => ({ id: line.id, character: line.character, start: line.start }))), before);
  });
  test('vertical pointer drag locks time; deliberate horizontal movement releases it', async () => {
    await host.evaluate(() => { pxPerSec = 60; timelineContainer.scrollLeft = 0; renderTimeline(); clearMultiSelection(); selectLine(session.lines[0]); });
    let positions = await host.evaluate(() => { const line = session.lines[0], block = document.getElementById('line-block-' + line.id).getBoundingClientRect(), row = document.querySelector('[data-character=Friend] .track-timeline').getBoundingClientRect(); return { x:block.left + 15, y:block.top + 15, targetY:row.top + 20, start:line.start }; });
    await host.mouse.move(positions.x, positions.y); await host.mouse.down(); await host.mouse.move(positions.x + 3, positions.targetY, { steps:6 });
    assert.equal(await host.$eval('#line-block-1', node => node.classList.contains('axis-locked')), true);
    await host.mouse.up(); await waitFor(host, () => session.lines[0].character === 'Friend');
    assert.equal(await host.evaluate(() => session.lines[0].start), positions.start);
    await host.evaluate(() => editorUndo()); await waitFor(host, () => session.lines[0].character === 'Hero');
    // Moving the selected clip reveals its destination; Undo can therefore change
    // viewport geometry. Hit the current clip rather than stale screen coordinates.
    positions = await host.evaluate(() => { const line = session.lines[0], block = document.getElementById('line-block-' + line.id).getBoundingClientRect(), row = document.querySelector('[data-character=Friend] .track-timeline').getBoundingClientRect(); return { x:block.left + 15, y:block.top + 15, targetY:row.top + 20, start:line.start }; });
    await host.mouse.move(positions.x, positions.y); await host.mouse.down(); await host.mouse.move(positions.x + 25, positions.targetY, { steps:6 });
    assert.equal(await host.$eval('#line-block-1', node => node.classList.contains('axis-locked')), false);
    await host.mouse.up(); await waitFor(host, start => session.lines[0].start > start, 10000, positions.start);
  });
  test('individual track height changes locally, persists and resets without changing lines', async () => {
    await waitFor(host, () => editorQueue.length === 0);
    const old = await host.evaluate(() => JSON.stringify(session.lines));
    await host.evaluate(() => { timelineContainer.scrollTop=0; renderTimeline(); });
    const handle = await host.$('[data-character=Hero] .role-height-handle'); await handle.scrollIntoView(); const box = await handle.boundingBox();
    await host.mouse.move(box.x + 20, box.y + 2); await host.mouse.down(); await host.mouse.move(box.x + 20, box.y + 70, { steps:5 }); await host.mouse.up();
    const height = await host.$eval('[data-character=Hero]', node => node.getBoundingClientRect().height);
    await host.reload(); await waitFor(host, () => session?.loaded);
    assert.equal(await host.$eval('[data-character=Hero]', node => node.getBoundingClientRect().height), height);
    assert.equal(await host.evaluate(() => JSON.stringify(session.lines)), old);
    await host.locator('[data-character=Hero] .role-height-handle').setTimeout(5000).click({ count:2 });
    assert.ok(await host.$eval('[data-character=Hero]', node => node.getBoundingClientRect().height) < height);
    assert.deepEqual(host.errors, []); assert.deepEqual(guest.errors, []);
  });
  test('real drag, both resize handles and keyboard cannot leave video bounds', async () => {
    await loadFixture(host); await host.evaluate(() => setStudioMode('edit')); await waitFor(host, () => session.mode === 'edit');
    await host.evaluate(() => { pxPerSec=60; timelineContainer.scrollLeft=0;timelineContainer.scrollTop=0;renderTimeline(); });
    const point = await host.$eval('#line-block-1', node => { const r=node.getBoundingClientRect();return {x:r.left+30,y:r.top+20}; });
    await host.mouse.move(point.x,point.y);await host.mouse.down();await host.mouse.move(point.x-700,point.y,{steps:5});await host.mouse.up();await waitFor(host,()=>editorQueue.length===0);
    assert.equal(await host.evaluate(()=>session.lines[0].start),0);
    const end = await host.$eval('#line-block-1 .line-resize-handle.end',node=>{const r=node.getBoundingClientRect();return{x:r.left+2,y:r.top+20};});
    await host.mouse.move(end.x,end.y);await host.mouse.down();await host.mouse.move(end.x+1400,end.y,{steps:5});await host.mouse.up();await waitFor(host,()=>editorQueue.length===0);
    assert.equal(await host.evaluate(()=>session.lines[0].end),12);
    const start = await host.$eval('#line-block-1 .line-resize-handle.start',node=>{const r=node.getBoundingClientRect();return{x:r.left+2,y:r.top+20};});
    await host.mouse.move(start.x,start.y);await host.mouse.down();await host.mouse.move(start.x-300,start.y,{steps:5});await host.mouse.up();await waitFor(host,()=>editorQueue.length===0);
    await host.evaluate(()=>{selectLine(session.lines[0]);handleEditorKey({code:'ArrowRight',shiftKey:true,preventDefault(){}});});await waitFor(host,()=>editorQueue.length===0);
    assert.deepEqual(await host.evaluate(()=>[session.lines[0].start,session.lines[0].end]),[0,12]);
  });
  test('mixed-track mouse movement stays relative and cancels the whole group at the final role', async () => {
    const viewport = host.viewport(); await host.setViewport({ ...viewport, height: 1200 });
    await loadFixture(host);await host.evaluate(()=>setStudioMode('edit'));await waitFor(host,()=>session.mode==='edit');
    await host.evaluate(async()=>{await queueEditorRequest(()=>['editor_add_track',{character:'Third'}]);pxPerSec=60;timelineContainer.scrollLeft=0;timelineContainer.scrollTop=0;renderTimeline();multiSelection.clear();multiSelection.add(1);multiSelection.add(2);});
    const points=await host.evaluate(()=>{const r=document.getElementById('line-block-1').getBoundingClientRect(),a=document.querySelector('[data-character=Friend]').getBoundingClientRect(),b=document.querySelector('[data-character=Third]').getBoundingClientRect();return{x:r.left+30,y:r.top+20,a:a.top+20,b:b.top+20};});
    await host.mouse.move(points.x,points.y);await host.mouse.down();await host.mouse.move(points.x+3,points.a,{steps:5});await host.mouse.up();await waitFor(host,()=>editorQueue.length===0);
    assert.deepEqual(await host.evaluate(()=>session.lines.slice(0,2).map(line=>line.character)),['Friend','Third']);
    await host.evaluate(()=>editorUndo());await waitFor(host,()=>session.lines[0].character==='Hero');
    const original=await host.evaluate(()=>session.lines.slice(0,2).map(({character,start,end})=>({character,start,end})));
    const finalPoints=await host.evaluate(()=>{const r=document.getElementById('line-block-1').getBoundingClientRect(),b=document.querySelector('[data-character=Third]').getBoundingClientRect();return{x:r.left+30,y:r.top+20,b:b.top+20,hit:document.elementFromPoint(r.left+55,b.top+20)?.closest('.track-row')?.dataset.character};});
    assert.equal(finalPoints.hit, 'Third', JSON.stringify(finalPoints));
    await host.mouse.move(finalPoints.x,finalPoints.y);await host.mouse.down();await host.mouse.move(finalPoints.x+25,finalPoints.b,{steps:5});await host.mouse.up();await waitFor(host,()=>editorQueue.length===0);
    assert.deepEqual(await host.evaluate(()=>session.lines.slice(0,2).map(({character,start,end})=>({character,start,end}))),original);
    await host.setViewport(viewport);
  });

});

describe('Single Player → Multiplayer → Single Player portable workflow', { skip: skipReason, timeout:120000 }, () => {
  let server, browser, host, guest, directory, project;
  before(async () => {
    server = await startServer({ DUBLINE_DESKTOP_ROOM:'main', DUBLINE_DESKTOP_HOST_TOKEN:'single-secret', DUBLINE_ROOM_PIN:'ABCD', DUBLINE_SINGLE_PLAYER:'1' });
    browser = await launchBrowser(server.port); host = await openPlayer(browser, server.url('main') + '&desktopHost=single-secret&workspace=single', 'Solo', { audioExpanded:false });
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-single-workflow-')); project = path.join(directory, 'Сцена.dubline');
  });
  after(async () => { await browser?.close(); await server?.cleanup(); if (directory) fs.rmSync(directory,{ recursive:true,force:true }); });
  test('single workspace automatically grants all roles and hides runtime networking while refusing guests', async () => {
    await waitFor(host, () => session?.singlePlayer && amHost());
    assert.equal(await host.$eval('#lobbyPanel', node => getComputedStyle(node).display), 'none');
    const denied = await fetch(`http://localhost:${server.port}/api/server-packs`); assert.equal(denied.status,403);
    guest = await openPlayer(browser, server.url('main'), 'Guest');
    await waitFor(guest, () => document.getElementById('deniedModal').style.display === 'flex');
  });
  test('video-only → add role → caption → Dub → real recording → save → close/reopen works without claims', async () => {
    await host.evaluate(() => openFilesModal());
    await (await host.$('#customVideoInput')).uploadFile(fixtureVideoPath());
    await host.evaluate(() => uploadCustomScene());
    await waitFor(host, () => session.loaded && session.mode === 'edit' && video.readyState >= 3);
    await host.evaluate(() => closeFilesModal());
    await host.evaluate(() => { addEditorTrack(); }); await answerTextPrompt(host, 'Hero');
    await waitFor(host, () => session.trackOrder.includes('Hero'));
    const box = await host.$eval('[data-character=Hero] .track-timeline', node => { const r = node.getBoundingClientRect(); return { x:r.left+60, y:r.top+25 }; });
    await host.mouse.click(box.x, box.y, { count:2 }); await waitFor(host, () => selectedLine?.id);
    await host.$eval('#editorCaption', node => { node.value = 'Unicode «Привет»\nsecond line'; node.dispatchEvent(new Event('input',{bubbles:true})); });
    await host.click('#editorLineForm button[type=submit]'); await waitFor(host, () => selectedLine.caption.includes('Привет'));
    await host.evaluate(() => setStudioMode('dub')); await waitFor(host, () => session.mode === 'dub');
    const id = await host.evaluate(() => selectedLine.id); await recordTake(host, id);
    await waitFor(host, () => session.lines[0].audioUrl && pendingTakeLines.size === 0);
    assert.equal(await host.evaluate(() => session.lines[0].claimedBy), null);
    assert.equal(await host.$$eval('#inspector [onclick]', nodes => nodes.some(node => /claimCharacter|unclaimCharacter|claimSingleLine|unclaimSingleLine/.test(node.getAttribute('onclick')))), false);
    await snapshotFile(host, project);
    await host.close(); await server.restart();
    host = await openPlayer(browser, server.url('main') + '&desktopHost=single-secret&workspace=single', 'Solo');
    await waitFor(host, () => session?.loaded && session.activeSessionId);
    await host.evaluate(() => openFilesModal()); await (await host.$('#projectInput')).uploadFile(project);
    await waitFor(host, () => session.lines[0]?.audioUrl?.includes('line_project_'));
    assert.ok(await host.evaluate(() => getLineOwner(session.lines[0]) === myName && canHearLine(session.lines[0])));
    await host.evaluate(() => closeFilesModal());
  });
  test('add sources and mix, promote existing project, admit second player, preserve both recordings in solo reopen and export', async () => {
    // Add external sources through the existing supported custom import, then import the portable scene.
    const bytes = await host.evaluate(async () => {
      const context = ensurePlayCtx(), buffer = context.createBuffer(1, 48000,48000); buffer.getChannelData(0).fill(0.03);
      return Array.from(new Uint8Array(audioBufferToWav(buffer)));
    });
    const source = path.join(directory,'source.wav'); fs.writeFileSync(source,Buffer.from(bytes));
    await host.evaluate(() => openFilesModal());
    await (await host.$('#customVideoInput')).uploadFile(fixtureVideoPath()); await (await host.$('#customOriginalInput')).uploadFile(source); await (await host.$('#customIntershumInput')).uploadFile(source);
    await host.evaluate(() => uploadCustomScene()); await waitFor(host, () => session.externalOriginalUrl && session.backingUrl && session.lines.length === 0);
    await host.evaluate(() => closeFilesModal());
    for (const name of ['Hero','Second']) { await host.evaluate(() => { addEditorTrack(); }); await answerTextPrompt(host,name); await waitFor(host,name => session.trackOrder.includes(name),10000,name); }
    await host.evaluate(async () => { await createEditorLineAt('Hero',1); await createEditorLineAt('Second',4); }); await waitFor(host,() => session.lines.length === 2);
    await host.evaluate(() => setStudioMode('dub')); await waitFor(host,() => session.mode === 'dub'); await recordTake(host,1);
    await host.evaluate(() => updateProjectAudio('backing','offset',-0.125)); await waitFor(host,() => session.projectAudio.backing.offset === -0.125);
    await snapshotFile(host, project);
    const old = await host.evaluate(() => ({ id:session.activeSessionId, video:session.videoUrl, audio:session.lines[0].audioUrl }));
    await parentRequest(server,'enable-multiplayer'); await waitFor(host,() => !session.singlePlayer && session.hasPassword);
    assert.deepEqual(await host.evaluate(() => ({ id:session.activeSessionId, video:session.videoUrl, audio:session.lines[0].audioUrl })),old);
    await guest.close(); guest = await openPlayer(browser,server.url('main'),'Guest'); await waitFor(guest,() => document.getElementById('passwordModal').style.display === 'flex');
    await guest.type('#passwordInput','ABCD'); await guest.evaluate(() => submitRoomPassword({preventDefault(){}})); await waitFor(guest,() => session?.loaded && myName === 'Guest');
    await guest.evaluate(() => claimCharacter('Second')); await waitFor(guest,() => session.characterClaims.Second === 'Guest'); await recordTake(guest,2);
    await waitFor(host,() => session.lines.every(line => line.audioUrl)); await snapshotFile(host,project);
    await host.close(); await guest.close(); await server.restart();
    host = await openPlayer(browser,server.url('main')+'&desktopHost=single-secret&workspace=single','Solo'); await waitFor(host,() => session?.singlePlayer && session.loaded && session.activeSessionId);
    await host.evaluate(() => openFilesModal()); await (await host.$('#projectInput')).uploadFile(project);
    await waitFor(host,() => session.lines.length === 2 && session.lines.every(line => line.audioUrl.includes('line_project_')));
    assert.equal(await host.evaluate(() => session.projectAudio.backing.offset),-0.125);
    assert.ok(await host.evaluate(() => session.lines.every(line => getLineOwner(line) === myName && canHearLine(line))));
    const exportResult = await host.evaluate(async () => {
      const mix = await mixSoundtrack(2,readRenderGains(),()=>{}); const blob = await renderWithWebCodecs(()=>{});
      const stem = await renderCharacterStem(session.lines,2); return { mix:mix.length, video:blob.size, stem:stem.length };
    });
    assert.ok(exportResult.mix > 1000 && exportResult.video > 1000 && exportResult.stem > 1000);
    assert.deepEqual(host.errors,[]);
  });
});
