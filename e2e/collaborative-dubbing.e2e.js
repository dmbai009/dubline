const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { readProject } = require('../server/projects');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor, waitUntil, claimAndSelect, recordTake, wait } = require('./helpers');

describe('Collaborative actor workflow', { skip: skipReason }, () => {
  let server, browser, host, room, serial = 0; const guests = [];
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  beforeEach(async () => { room = `actors-${++serial}`; host = await openPlayer(browser, server.url(room), 'Host'); await loadFixture(host); });
  afterEach(async () => { for (const page of [host, ...guests.splice(0)]) { assert.deepEqual(page.errors, []); await page.browserContext().close(); } });
  async function guest(name) { const page = await openPlayer(browser, server.url(room), name); guests.push(page); await waitFor(page, () => session?.loaded); return page; }
  test('Space and R finish the active recording even after selection changes, with one saved take', async () => {
    await claimAndSelect(host, 1);
    await host.focus('#timelineContainer'); await host.keyboard.press('KeyR');
    await waitFor(host, () => recordState === 'recording'); await wait(250);
    await host.evaluate(() => selectLine(session.lines.find(line => line.id === 2)));
    await host.focus('#timelineContainer'); await host.keyboard.down('Space'); await host.keyboard.down('Space'); await host.keyboard.up('Space');
    await waitFor(host, () => recordState === 'idle' && session.lines.find(line => line.id === 1).audioUrl && !pendingTakeLines.size);
    const take = await host.evaluate(() => session.lines.find(line => line.id === 1).audioUrl);
    assert.equal(await host.evaluate(() => !!session.lines.find(line => line.id === 2).audioUrl), false);
    await claimAndSelect(host, 1); await host.focus('#timelineContainer'); await host.keyboard.press('KeyR');
    await waitFor(host, () => recordState === 'preparing'); await host.keyboard.press('Space');
    await waitFor(host, () => recordState === 'idle' && !processingRecordings.size);
    assert.equal(await host.evaluate(() => session.lines.find(line => line.id === 1).audioUrl), take);
    await host.keyboard.press('KeyR'); await waitFor(host, () => recordState === 'recording'); await wait(250); await host.keyboard.press('KeyR');
    await waitFor(host, old => recordState === 'idle' && session.lines.find(line => line.id === 1).audioUrl !== old, 10000, take);
    await host.keyboard.press('Space'); await waitFor(host, () => !video.paused);
    await host.keyboard.press('Space'); assert.equal(await host.evaluate(() => video.paused), true);
  });
  test('an absent moderator uses one normal card, keeps its assignment identity and fits the 68px lobby', async () => {
    const actor = await guest('Absent');
    await actor.evaluate(() => claimSingleLine(1)); await waitFor(host, () => session.lines[0].claimedBy === 'Absent');
    await host.evaluate(() => new Promise(resolve => socket.emit('host_grant_moderator', { nick: 'Absent' }, resolve)));
    const id = await waitFor(host, () => session.moderators.find(entry => entry.nick === 'Absent')?.id);
    await actor.evaluate(() => socket.disconnect()); await waitFor(host, id => session.moderators.some(entry => entry.id === id && !entry.online), 5000, id);
    assert.equal(await host.$$eval('.player-card[data-moderator-id]', nodes => nodes.length), 1);
    assert.equal(await host.$$eval('.offline-moderator', nodes => nodes.length), 0);
    const observer = await guest('Observer');
    assert.equal(await observer.$$eval('.player-card.offline .tag.moderator', nodes => nodes.length), 1);
    assert.equal(await observer.$$eval('.participant-menu', nodes => nodes.length), 0);
    await host.evaluate(() => document.body.classList.add('lobby-compact'));
    assert.equal(await host.$eval('#lobbyList', node => node.scrollWidth <= node.clientWidth), true);
    assert.equal(await host.$eval('.player-card.offline .avatar', node => node.getBoundingClientRect().width > 0), true);
    await host.evaluate(() => document.body.classList.remove('lobby-compact'));
    await host.click('.player-card.offline .participant-menu summary');
    await host.focus('.player-card.offline .participant-menu button');
    await host.evaluate(() => { renderLobby(); renderLobby(); });
    assert.equal(await host.evaluate(() => document.activeElement.closest('.participant-menu')?.open), true);
    await host.click('.player-card.offline .participant-menu button');
    await waitFor(host, () => !session.moderators.length);
    assert.equal(await host.$$eval('.player-card.offline', nodes => nodes.length), 1, 'contribution survives revocation');
    await actor.evaluate(() => socket.connect()); await waitFor(actor, () => hasSceneMediaAccess());
    assert.equal(await actor.$$eval('.participant-menu', nodes => nodes.length), 0);
  });
  test('watch status belongs to the transport and hides with the existing fullscreen idle state', async () => {
    const actor = await guest('Watcher');
    await host.evaluate(() => hostWatchStart()); await waitFor(actor, () => watchMode && !document.getElementById('watchTransport').hidden);
    assert.equal(await actor.$eval('#watchLabel', node => !!node.closest('.studio-transport')), true);
    assert.equal(await actor.$$eval('.watch-bar', nodes => nodes.length), 0);
    await waitFor(actor, () => !video.paused);
    await actor.evaluate(() => toggleVideoFullscreen());
    await waitFor(actor, () => !!document.fullscreenElement);
    await actor.evaluate(() => document.activeElement.blur());
    await actor.mouse.move(200, 200);
    await waitFor(actor, () => document.querySelector('.video-wrapper').classList.contains('fullscreen-idle'), 7000);
    await waitFor(actor, () => getComputedStyle(document.querySelector('.studio-transport')).opacity === '0');
    await actor.mouse.move(230, 230);
    await waitFor(actor, () => getComputedStyle(document.querySelector('.studio-transport')).opacity === '1');
    await actor.evaluate(() => document.exitFullscreen());
    await actor.click('#watchLeaveBtn'); await waitFor(actor, () => !watchMode && document.getElementById('watchTransport').hidden);
  });
  test('Space keeps text, modal and focused-button behavior during an active recording', async () => {
    await claimAndSelect(host, 1); await recordTake(host, 1);
    await host.focus('#timelineContainer'); await host.keyboard.press('KeyR'); await waitFor(host, () => recordState === 'recording');
    await host.focus('[data-retake-comment="1"]'); await host.keyboard.press('Space');
    assert.equal(await host.evaluate(() => recordState), 'recording');
    assert.equal(await host.$eval('[data-retake-comment="1"]', node => node.value), ' ');
    await host.evaluate(() => openSettingsModal()); await host.keyboard.press('Space');
    assert.equal(await host.evaluate(() => recordState), 'recording');
    await host.keyboard.press('Escape');
    await host.focus('#transportCC'); await host.keyboard.press('Space');
    assert.equal(await host.evaluate(() => recordState), 'recording');
    await host.focus('#timelineContainer'); await host.keyboard.press('KeyR');
    await waitFor(host, () => recordState === 'idle' && !processingRecordings.size && !pendingTakeLines.size);
    await host.click('[data-retake-discard="1"]'); await waitFor(host, () => !hasRetakeDrafts());
  });
  test('offline assignments without contributions remain distinct from a new actor using the same name', async () => {
    const first = await guest('Namesake');
    await host.evaluate(() => new Promise(resolve => socket.emit('host_grant_moderator', { nick: 'Namesake' }, resolve)));
    const id = await waitFor(host, () => session.moderators[0]?.id);
    await first.evaluate(() => socket.disconnect()); await waitFor(host, () => !session.moderators[0].online);
    const replacement = await guest('Namesake');
    await waitFor(host, () => [...document.querySelectorAll('.player-name')].filter(node => node.textContent === 'Namesake').length === 2);
    assert.equal(await host.$$eval('.player-card[data-moderator-id]', nodes => nodes.length), 1);
    assert.equal(await replacement.evaluate(() => canModerate()), false);
    assert.equal(await replacement.$$eval('.participant-menu', nodes => nodes.length), 0);
    for (const compact of [true, false, true, false]) {
      await host.evaluate(compact => document.body.classList.toggle('lobby-compact', compact), compact);
      assert.equal(await host.$eval('#lobbyList', node => node.scrollWidth <= node.clientWidth), true);
    }
    await host.click('.player-card.offline .participant-menu summary'); await host.click('.player-card.offline .participant-menu button');
    await waitFor(host, () => !session.moderators.length);
    assert.equal(await host.$$eval('.player-card.offline', nodes => nodes.length), 0);
    assert.equal(typeof id, 'string');
  });
  test('format 5 saves an actual Telephone take and comment through Files, reopens it and survives server restart', async () => {
    await claimAndSelect(host, 1); await recordTake(host, 1);
    await host.evaluate(() => new Promise(resolve => { const line = session.lines[0]; socket.emit('set_take_props', { sessionId: session.activeSessionId, lineId: line.id, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision || 0, effect: 'telephone' }, resolve); }));
    await waitFor(host, () => session.lines[0].effect === 'telephone');
    await host.type('[data-retake-comment="1"]', 'Сохранить конец фразы'); await host.click('[data-retake-form="1"] button[type=submit]');
    await waitFor(host, () => session.lines[0].retakeComment === 'Сохранить конец фразы' && !editorQueue.length);
    const before = await host.evaluate(() => structuredClone(session.lines[0]));
    const cdp = await host.createCDPSession(); await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: server.dirs.data });
    await host.evaluate(() => { openFilesModal(); switchFilesTab('projects'); });
    const download = host.waitForResponse(response => response.url().includes('/api/export-project'));
    await host.click('#projectExportBtn'); const response = await download; assert.equal(response.status(), 200);
    await waitUntil(() => fs.readdirSync(server.dirs.data).some(name => name.endsWith('.dubline')), 15000);
    const bytes = fs.readFileSync(path.join(server.dirs.data, fs.readdirSync(server.dirs.data).find(name => name.endsWith('.dubline')))), project = readProject(bytes);
    assert.equal(project.manifest.formatVersion, 5);
    assert.equal(project.manifest.project.lines[0].retakeComment, before.retakeComment);
    const take = project.manifest.project.lines[0].take;
    assert.equal(take.effect, 'telephone');
    assert.deepEqual(project.files.get(take.asset), fs.readFileSync(path.join(server.dirs.uploads, path.basename(before.audioUrl))));
    const file = path.join(server.dirs.data, 'actor-project.dubline'); fs.writeFileSync(file, bytes);
    await waitFor(host, () => !document.getElementById('projectInput').disabled);
    const imported = host.waitForResponse(response => response.url().includes('/api/import-project'));
    await (await host.$('#projectInput')).uploadFile(file); assert.equal((await imported).status(), 200);
    await waitFor(host, () => session.lines[0].effect === 'telephone' && session.lines[0].retakeComment === 'Сохранить конец фразы');
    await server.restart(); await waitFor(host, () => socket.connected && hasSceneMediaAccess(), 15000);
    await host.reload(); await waitFor(host, () => session?.loaded && session.lines[0].audioUrl);
    const after = await host.evaluate(async () => ({ line: session.lines[0], processed: !!await getProcessedTake(session.lines[0]) }));
    for (const field of ['caption', 'start', 'end', 'recordedBy', 'effect', 'pitch', 'volume', 'pan', 'needsRetake', 'retakeComment']) assert.equal(after.line[field], before[field], field);
    assert.equal(after.processed, true);
    assert.deepEqual(fs.readFileSync(path.join(server.dirs.uploads, path.basename(after.line.audioUrl))), project.files.get(take.asset));
    await host.select('#timelineScopeFilter', 'choose');
    assert.deepEqual(await host.evaluate(() => DublineTimelineFilters.ids()), [], 'recorded lines are only visually hidden');
    const exported = await host.evaluate(async () => {
      const line = session.lines[0], scene = structuredClone(session), snapshot = { scene, takes: [line], gains: DublineProjectAudio.gains(scene.projectAudio), originalUrl: '', backingUrl: '' };
      const fx = DublineAudioFx, original = fx.connectTake, buffers = [];
      fx.connectTake = (ctx, source, destination, take) => { if (take.effect === 'telephone') buffers.push(source.buffer); return original(ctx, source, destination, take); };
      try {
        const mixed = await mixSoundtrack(12, snapshot.gains, () => {}, snapshot), stem = await renderCharacterStem([line], 12, 48000, snapshot);
        const energy = buffer => buffer.getChannelData(0).reduce((sum, value) => sum + value ** 2, 0);
        // Existing master limiters have different thresholds; compare their input.
        return { mixed: energy(mixed), stem: energy(stem), shared: buffers.length === 2 && buffers[0] === buffers[1] };
      } finally {
        fx.connectTake = original;
      }
    });
    assert.ok(exported.mixed > 1e-12 && exported.stem > 1e-12); assert.equal(exported.shared, true, 'Telephone soundtrack and stem reuse the same processed take');
  });
  test('personal ownership and selected-role exceptions share visibility with search and survive only in their own scene', async () => {
    const actor = await guest('Filter actor');
    await actor.evaluate(() => { claimCharacter('Hero'); claimSingleLine(2); });
    await waitFor(actor, () => session.characterClaims.Hero === myName && session.lines.find(line => line.id === 2).claimedBy === myName);
    await actor.select('#timelineScopeFilter', 'mine');
    assert.deepEqual(await actor.evaluate(() => DublineTimelineFilters.ids()), [1, 2, 3]);
    assert.deepEqual(await host.evaluate(() => DublineTimelineFilters.ids()), [1, 2, 3, 4]);
    await actor.select('#timelineScopeFilter', 'choose'); await actor.click('#timelineChooseFilter');
    await actor.click('[data-filter-role="Hero"]');
    await actor.select('#timelineLineFilter', '4'); await actor.click('#timelineFilterPicker button:nth-of-type(3)');
    await actor.select('#timelineLineFilter', '1'); await actor.click('#timelineFilterPicker button:nth-of-type(4)');
    assert.deepEqual(await actor.evaluate(() => DublineTimelineFilters.ids()), [3, 4]);
    assert.equal(await actor.$eval('#line-block-1', node => getComputedStyle(node).display), 'none');
    await actor.keyboard.press('Escape'); await actor.evaluate(() => openTimelineSearch()); await actor.type('#timelineSearchInput', 'Hello');
    await waitFor(actor, () => document.getElementById('timelineSearchCount').textContent.includes('0'));
    await actor.reload(); await waitFor(actor, () => session?.loaded && hasSceneMediaAccess());
    assert.deepEqual(await actor.evaluate(() => DublineTimelineFilters.ids()), [3, 4]);
    await loadFixture(host); await waitFor(actor, () => document.getElementById('timelineScopeFilter').value === 'all');
    assert.deepEqual(await actor.evaluate(() => DublineTimelineFilters.ids()), [1, 2, 3, 4]);
  });
  test('Mine plus retakes follows current ownership rather than the author and never changes the shared mix', async () => {
    const actor = await guest('Retake filter');
    await claimAndSelect(actor, 1); await recordTake(actor, 1);
    await host.evaluate(() => new Promise(resolve => {
      const line = session.lines.find(line => line.id === 1);
      socket.emit('set_needs_retake', { sessionId: session.activeSessionId, lineId: 1, audioUrl: line.audioUrl, takeMixRevision: line.takeMixRevision || 0, value: true }, resolve);
    }));
    await waitFor(actor, () => session.lines[0].needsRetake);
    await actor.select('#timelineScopeFilter', 'mine'); await actor.select('#timelineStatusFilter', 'retake');
    assert.deepEqual(await actor.evaluate(() => DublineTimelineFilters.ids()), [1]);
    const before = await host.evaluate(() => JSON.stringify(session.projectAudio));
    await actor.evaluate(() => unclaimSingleLine(1)); await waitFor(actor, () => !DublineTimelineFilters.ids().length);
    assert.equal(await actor.$eval('.track-row[data-character="Hero"]', node => getComputedStyle(node).display), 'none');
    assert.equal(await actor.evaluate(() => session.lines[0].recordedBy), 'Retake filter');
    assert.equal(await host.evaluate(() => JSON.stringify(session.projectAudio)), before);
  });
  test('Dub inspector moves a recorded line without editing its timing or opening bulk tools', async () => {
    const actor = await guest('Mover'); await claimAndSelect(actor, 1); await recordTake(actor, 1);
    const before = await actor.evaluate(() => structuredClone(session.lines.find(line => line.id === 1)));
    await actor.select('#charInput', 'Friend'); await actor.click('.insp-char-form button[type=submit]');
    await waitFor(host, () => session.lines.find(line => line.id === 1).character === 'Friend');
    const after = await host.evaluate(() => session.lines.find(line => line.id === 1));
    for (const field of ['id', 'caption', 'start', 'end', 'audioUrl', 'recordedBy', 'effect', 'pitch', 'volume', 'pan', 'audioStart']) assert.equal(after[field], before[field], field);
    assert.equal(await actor.evaluate(() => session.mode), 'dub');
    assert.equal(await actor.$$eval('#multiCharInput', nodes => nodes.length), 0);
    const stranger = await guest('Stranger'); await stranger.evaluate(() => selectLine(session.lines.find(line => line.id === 1)));
    assert.equal(await stranger.$$eval('#charInput', nodes => nodes.length), 0);
  });
  test('retake comments notify only their current owner, survive redraw/reload, and close with the next take', async () => {
    const actor = await guest('Actor'), other = await guest('Other'); await claimAndSelect(actor, 1); await recordTake(actor, 1);
    await host.evaluate(() => selectLine(session.lines.find(line => line.id === 1)));
    await host.type('[data-retake-comment="1"]', 'Больше эмоций <img src=x onerror=alert(1)>');
    await host.click('[data-retake-form="1"] button[type=submit]');
    await waitFor(actor, () => session.lines[0].needsRetake && session.lines[0].retakeComment.includes('Больше'));
    await waitFor(actor, () => document.getElementById('toast').textContent.includes('requested a retake'));
    assert.equal(await other.evaluate(() => document.getElementById('toast').textContent.includes('requested a retake')), false);
    assert.equal(await actor.$eval('#myRetakeCount', node => node.hidden), false);
    await actor.click('#myRetakeCount'); assert.equal(await actor.$eval('[data-retake-comment="1"]', node => node.value), 'Больше эмоций <img src=x onerror=alert(1)>');
    assert.equal(await actor.$$eval('.retake-controls img', nodes => nodes.length), 0);
    await actor.reload(); await waitFor(actor, () => session?.loaded && !document.getElementById('myRetakeCount').hidden);
    await actor.click('#myRetakeCount'); await actor.focus('[data-retake-comment="1"]'); await actor.keyboard.press('End'); await actor.keyboard.type(' Ещё замечание');
    await host.evaluate(() => renderLobby());
    await actor.evaluate(() => showInspector(selectedLine)); assert.equal(await actor.evaluate(() => document.activeElement.dataset.retakeComment), '1');
    assert.ok(await actor.$eval('[data-retake-comment="1"]', node => node.value.endsWith('Ещё замечание')));
    await actor.click('[data-retake-form="1"] button[type=submit]');
    await waitFor(host, () => session.lines[0].retakeComment.endsWith('Ещё замечание'));
    await recordTake(actor, 1); await waitFor(host, () => !session.lines[0].needsRetake && !session.lines[0].retakeComment);
    assert.equal(await actor.$eval('#myRetakeCount', node => node.hidden), true);
  });
  test('every effect retains bounded speech level, Telephone differs from Radio, and dry/wet endpoints stay non-destructive', async () => {
    const result = await host.evaluate(async () => {
      const reports = [];
      for (const level of [.00002, .02, .2, .6]) {
        const buffer = new AudioBuffer({ length: 48000, sampleRate: 48000, numberOfChannels: 1 }), dry = buffer.getChannelData(0);
        for (let i = 4800; i < 36000; i++) dry[i] = level * Math.sin(Math.PI * (i - 4800) / 31200) * (.5 * Math.sin(i * 2 * Math.PI * 220 / 48000) + .3 * Math.sin(i * 2 * Math.PI * 1100 / 48000) + .2 * Math.sin(i * 2 * Math.PI * 2700 / 48000));
        if (await renderVoice(buffer, 'none') !== buffer) throw Error('Dry source was replaced');
        for (const effect of Object.keys(VOICE_EFFECTS).filter(effect => effect !== 'none')) {
          const processed = await renderVoice(buffer, effect), out = processed.getChannelData(0), measured = DublineVoiceLevel.correction(dry, out, 48000);
          reports.push({ level, effect, db: measured.wetRms ? 20 * Math.log10(measured.wetRms / measured.dryRms) : -100,
            finite: out.every(Number.isFinite), peak: out.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0), tail: processed.duration - buffer.duration });
        }
        const wet = await renderVoice(buffer, 'telephone'), half = await renderVoice(buffer, 'telephone', 0, null, .5), radio = await renderVoice(buffer, 'radio');
        let error = 0, difference = 0;
        for (let i = 0; i < wet.length; i++) { error = Math.max(error, Math.abs(half.getChannelData(0)[i] - ((dry[i] || 0) + wet.getChannelData(0)[i]) / 2)); difference += Math.abs(wet.getChannelData(0)[i] - (radio.getChannelData(0)[i] || 0)); }
        if (error > 1e-6 || !difference) throw Error('Effect blend or Telephone identity changed');
      }
      return reports;
    });
    for (const report of result) {
      assert.equal(report.finite, true, JSON.stringify(report)); assert.ok(report.peak <= .950001, JSON.stringify(report));
      if (report.level >= .02) assert.ok(Math.abs(report.db) < 3.2, JSON.stringify(report));
      else assert.ok(report.db <= .01, 'near-silent speech cannot be boosted: ' + JSON.stringify(report));
    }
  });
  test('an offline owner finds remarks on return without repeating notifications on snapshots or reconnect', async () => {
    const actor = await guest('Returning'); await claimAndSelect(actor,1); await recordTake(actor,1);
    await actor.evaluate(() => socket.disconnect());
    await host.evaluate(() => selectLine(session.lines[0])); await host.type('[data-retake-comment="1"]','Исправить интонацию');
    await host.click('[data-retake-form="1"] button[type=submit]'); await waitFor(host,()=>session.lines[0].needsRetake);
    await actor.reload(); await waitFor(actor,()=>session?.loaded && !document.getElementById('myRetakeCount').hidden);
    await waitFor(actor,()=>document.getElementById('toast').textContent.includes('You have 1'));
    await actor.evaluate(() => { window.testNotices=[]; const original=showToast; showToast=(...args)=>{ testNotices.push(args[0]);return original(...args); }; socket.emit('editor_resync',{},result=>socket.emit('editor_resync',{})); });
    await actor.evaluate(() => { socket.disconnect(); socket.connect(); }); await waitFor(actor,()=>hasSceneMediaAccess());
    assert.deepEqual(await actor.evaluate(()=>testNotices.filter(text=>text.includes('retake')||text.includes('You have'))),[]);
    await actor.click('#myRetakeCount'); assert.equal(await actor.$eval('[data-retake-comment="1"]',node=>node.value),'Исправить интонацию');
  });
  test('the filter picker stays within the window across six themes, three languages and 100–150 percent layout scale', async () => {
    await host.select('#timelineScopeFilter','choose'); await host.click('#timelineChooseFilter');
    for(const width of [1024,1920]) for(const scale of [1,1.5]) {
      await host.setViewport({width,height:768});
      for(const theme of ['midnight','graphite','light','ocean','forest','sunset']) for(const language of ['en','ru','uk']) {
        const state=await host.evaluate(async(theme,language,scale)=>{
          document.documentElement.dataset.theme=theme; document.documentElement.style.zoom=String(scale); await DublineI18n.setLanguage(language); window.dispatchEvent(new Event('resize'));
          const node=document.getElementById('timelineFilterPicker'), rect=node.getBoundingClientRect(), css=getComputedStyle(node);
          return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:innerWidth,height:innerHeight,display:css.display,
            roleLabel:document.getElementById('timelineScopeFilter').options[1].textContent,expected:t('filter.mine'),missing:[...DublineI18n.missing],colors:[css.color,css.backgroundColor]};
        },theme,language,scale);
        assert.equal(state.display,'block'); assert.equal(state.roleLabel,state.expected); assert.deepEqual(state.missing,[]);
        assert.ok(state.left>=0&&state.right<=state.width+1&&state.top>=0&&state.bottom<=state.height+1,JSON.stringify({theme,language,scale,...state}));
        assert.notEqual(state.colors[0],state.colors[1]);
      }
    }
    await host.evaluate(()=>document.documentElement.style.zoom='1'); await host.keyboard.press('Escape');
    assert.equal(await host.$eval('#timelineFilterPicker',node=>node.hidden),true);
    assert.equal(await host.evaluate(()=>document.activeElement.id),'timelineChooseFilter');
  });
});
