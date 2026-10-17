const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor, fixtureVideoPath } = require('./helpers');
const { serialize } = require('../src/server/subtitle-export');
const sourceCues = [
  { start:1.234, end:3.567, character:'Нагито, [роль] &lt;', caption:'Первая строка\nВторая строка <i>не тег</i>' },
  { start:2, end:4, character:'Голоса на фоне', caption:'Имя: это текст\n\nЕщё абзац {\\p1} и буквальное \\N.' },
  { start:5.001, end:5.004, character:'Нагито, [роль] &lt;', caption:'Короткая реплика' }
];

describe('subtitle export and import into another project', { skip:skipReason, timeout:120000 }, () => {
  let server, browser, host, guest, destination;
  const exported = new Map();
  const captureSubtitles = page => page.evaluate(() => {
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      if (/subrip|ssa|vtt/.test(blob.type)) window.testSubtitleBlob = blob.text();
      return create(blob);
    };
  });
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port);
    host = await openPlayer(browser, server.url('subtitle-source'), 'Host'); await loadFixture(host);
    const uploaded = await host.evaluate(async ({ text, encoded }) => {
      const form = new FormData(); form.append('clientId', clientId);
      form.append('video', new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))]), 'scene.mp4');
      form.append('subtitles', new Blob([text]), 'scene.ass');
      const response = await fetch('/api/upload-custom?room=' + currentRoom, { method:'POST', body:form });
      return { status:response.status, text:await response.text() };
    }, { text:serialize(sourceCues, 'ass'), encoded:fs.readFileSync(fixtureVideoPath()).toString('base64') });
    assert.equal(uploaded.status, 200, uploaded.text);
    await waitFor(host, () => session?.lines?.length === 3);
    assert.deepEqual(await host.evaluate(() => session.lines.map(({ start,end,character,caption }) => ({ start,end,character,caption }))), sourceCues);
    await captureSubtitles(host);
    guest = await openPlayer(browser, server.url('subtitle-source'), 'Guest'); await waitFor(guest, () => session?.loaded);
    destination = await openPlayer(browser, server.url('subtitle-destination'), 'OtherHost');
  });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  test('subtitle card is between stems and Voxalike, with three useful format tooltips', async () => {
    await host.evaluate(() => { openFilesModal(); switchFilesTab('export'); });
    const info = await host.evaluate(() => {
      const card = document.getElementById('subtitleExportCard');
      return { before:!!card.previousElementSibling.querySelector('#downloadStemsBtn'), after:!!card.nextElementSibling.querySelector('#packExportBtn'),
        formats:[...card.querySelectorAll('button')].map(b => ({ format:b.dataset.subtitleFormat, hint:b.title, disabled:b.disabled })) };
    });
    assert.equal(info.before, true); assert.equal(info.after, true);
    assert.deepEqual(info.formats.map(f => f.format), ['srt','ass','vtt']);
    assert.ok(info.formats.every(f => f.hint.length > 50 && !f.disabled));
  });
  test('a returning host can export an existing scene after session state arrives before host presence', async () => {
    await host.reload({ waitUntil:'domcontentloaded' });
    await waitFor(host, () => session?.loaded && amHost());
    await host.evaluate(() => { openFilesModal(); switchFilesTab('export'); });
    assert.deepEqual(await host.$$eval('[data-subtitle-format]', buttons => buttons.map(button => button.disabled)), [false, false, false]);
    await captureSubtitles(host);
  });
  for (const format of ['srt','ass','vtt']) {
    test(`${format} downloads through the UI without changing source cues`, async () => {
      const before = await host.evaluate(() => JSON.stringify(session.lines));
      const response = host.waitForResponse(r => r.url().includes('/api/export-subtitles'));
      await host.click(`[data-subtitle-format="${format}"]`);
      const result = await response; assert.equal(result.status(), 200, await result.text());
      await waitFor(host, () => !subtitleExportBusy);
      exported.set(format, await host.evaluate(() => window.testSubtitleBlob));
      assert.match(exported.get(format), /-->|Dialogue:/, JSON.stringify(result.headers()));
      assert.match(result.headers()['content-disposition'], new RegExp(`\\.${format}`));
      await waitFor(host, () => !subtitleExportBusy);
      assert.equal(await host.evaluate(() => JSON.stringify(session.lines)), before);
    });
    test(`${format} imports roles, text and times into a separate project without recordings`, async () => {
      const expected = await host.evaluate(() => session.lines.map(({ start,end,character,caption }) => ({ start,end,character,caption })).sort((a,b) => a.start-b.start));
      const oldSession = await destination.evaluate(() => session?.activeSessionId);
      const result = await destination.evaluate(async ({ text, format, encoded }) => {
        const form = new FormData(); form.append('clientId', clientId); form.append('title', 'Imported subtitles');
        form.append('video', new Blob([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))]), 'scene.mp4');
        form.append('subtitles', new Blob([text]), 'scene.' + format);
        const response = await fetch('/api/upload-custom?room=' + currentRoom, { method:'POST', body:form });
        return { status:response.status, text:await response.text() };
      }, { text:exported.get(format), format, encoded:fs.readFileSync(fixtureVideoPath()).toString('base64') });
      assert.equal(result.status, 200, result.text);
      await waitFor(destination, old => session?.loaded && session.activeSessionId !== old, 15000, oldSession);
      assert.deepEqual(await destination.evaluate(() => session.lines.map(({ start,end,character,caption }) => ({ start,end,character,caption }))), expected);
      assert.ok(await destination.evaluate(() => session.lines.every(l => !l.audioUrl && !l.claimedBy)));
      const roles = await destination.evaluate(() => [...document.querySelectorAll('.track-row[data-character]')].map(n => n.dataset.character));
      assert.ok(expected.every(line => roles.includes(line.character)));
    });
  }
  test('guest cannot export using a forged request; missing/expired snapshots are rejected', async () => {
    const request = page => page.evaluate(async () => {
      const response = await fetch('/api/export-subtitles', { method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ room:currentRoom,clientId,format:'ass',sessionId:session.activeSessionId,barrierToken:'invalid' }) });
      return response.status;
    });
    assert.equal(await request(guest), 403); assert.equal(await request(host), 409);
    const hostId = await host.evaluate(() => clientId);
    assert.equal(await guest.evaluate(async hostId => (await fetch('/api/export-subtitles', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ room:currentRoom,clientId:hostId,format:'ass' })
    })).status, hostId), 403, 'body clientId cannot impersonate the host cookie');
  });
  test('range tools use the existing footer and never increase timeline header height', async () => {
    await host.evaluate(() => { closeFilesModal(); });
    const before = await host.$eval('#timelineContainer', e => e.getBoundingClientRect().height);
    await host.evaluate(() => DublineTimelineRange.set(1, 2));
    const result = await host.evaluate(() => {
      const tools = document.querySelector('.timeline-range-tools'), zoom = document.querySelector('.zoom-controls');
      const a = tools.getBoundingClientRect(), b = zoom.getBoundingClientRect();
      return { footer:!!tools.closest('.timeline-footer-controls'), aligned:Math.abs(a.top + a.height/2 - b.top - b.height/2)<2,
        left:a.right<=b.left, height:timelineContainer.getBoundingClientRect().height };
    });
    assert.equal(result.footer, true); assert.equal(result.aligned, true); assert.equal(result.left, true); assert.ok(Math.abs(result.height - before) < 1);
    assert.deepEqual(host.errors, []);
  });
  test('imported subtitles keep literal text, roles and line breaks after server restart', async () => {
    const id = await destination.evaluate(() => session.activeSessionId);
    await server.restart();
    await waitFor(destination, scene => socket.connected && session?.activeSessionId === scene && session?.loaded, 15000, id);
    // Wait for the authoritative reconnect snapshot, not the previous local copy.
    await waitFor(destination, () => editorConfirmedConnection === socket.id);
    assert.deepEqual(await destination.evaluate(() => session.lines.map(({ start,end,character,caption }) => ({ start,end,character,caption }))), sourceCues);
  });
});
