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
