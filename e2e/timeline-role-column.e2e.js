const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor } = require('./helpers');

describe('personal timeline role column', { skip: skipReason, timeout: 120000 }, () => {
  let server, browser, page;
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port);
    page = await openPlayer(browser, server.url('role-column'), 'Host', { audioExpanded: false });
    await loadFixture(page);
    await page.evaluate(() => { layout.top = 300; applyLayout(); selectLine(session.lines[0]); });
  });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  async function drag(delta, selector = '.track-row[data-character] .role-column-handle', cancel = false) {
    await page.$eval(selector, node => node.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    const box = await page.$eval(selector, node => { const b = node.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + Math.min(20, b.height / 2) }; });
    await page.mouse.move(box.x, box.y); await page.mouse.down();
    await page.mouse.move(box.x + delta, box.y + 9, { steps: 8 });
    if (cancel) await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    await waitFor(page, () => !document.body.classList.contains('resizing-role-column'));
  }
  const snapshot = () => page.evaluate(() => ({
    lines: JSON.stringify(session.lines), order: session.trackOrder, scale: pxPerSec,
    time: video.currentTime, selected: selectedLine?.id, multi: [...multiSelection],
    undo: editorQueue.length, scroll: timelineContainer.scrollLeft
  }));
  test('default is unchanged; real edge drag moves ruler, audio and cues together without editing them', async () => {
    assert.equal(await page.evaluate(() => labelWidth), 180);
    await page.evaluate(() => { timelineContainer.scrollLeft = 80; video.currentTime = 3.4; });
    await waitFor(page, () => !video.seeking);
    const before = await snapshot();
    const cue = await page.$('#line-block-1');
    await drag(120);
    assert.equal(await page.evaluate(() => labelWidth), 300);
    assert.deepEqual(await snapshot(), before);
    assert.equal(await page.evaluate(node => node === document.getElementById('line-block-1'), cue), true, 'cues are not rebuilt');
    await page.evaluate(() => { localStorage.setItem('dubline_audio_collapsed', '0'); renderTimeline(); });
    const geometry = await page.evaluate(() => {
      const nodes = [...timeline.querySelectorAll('.track-label,.ruler-corner')];
      return { widths: nodes.map(n => n.getBoundingClientRect().width), origins: [...timeline.querySelectorAll('.ruler-ticks,.track-timeline,.studio-wave-area')].map(n => n.getBoundingClientRect().left), cursor: getComputedStyle(nodes[0].querySelector('.role-column-handle')).cursor };
    });
    assert.ok(geometry.widths.every(w => w === 300), JSON.stringify(geometry));
    assert.ok(geometry.origins.every(x => Math.abs(x - geometry.origins[0]) < 1), JSON.stringify(geometry));
    assert.equal(geometry.cursor, 'col-resize');
  });
  test('minimum and maximum, ruler edge and cancellation work in Edit Mode without a mutation or seek', async () => {
    await page.evaluate(() => setStudioMode('edit')); await waitFor(page, () => session.mode === 'edit');
    await page.evaluate(() => { selectLine(session.lines[0]); multiSelection.add(1); multiSelection.add(2); refreshMultiSelection(); });
    const before = await snapshot();
    await drag(700, '.ruler-corner .role-column-handle');
    assert.equal(await page.evaluate(() => labelWidth), 400);
    await drag(-700); assert.equal(await page.evaluate(() => labelWidth), 180);
    await drag(80); assert.equal(await page.evaluate(() => labelWidth), 260);
    await drag(80, undefined, true); assert.equal(await page.evaluate(() => labelWidth), 260);
    assert.deepEqual(await snapshot(), before);
    assert.equal(await page.evaluate(() => !!window.activeEditorGesture || !!window.transportScrubbing), false);
    assert.equal(await page.evaluate(() => localStorage.getItem('dubline_role_column_width')), '260');
  });
  test('preference survives reload but another participant keeps the default and no project state is added', async () => {
    await page.reload(); await waitFor(page, () => session?.loaded && document.querySelector('.role-column-handle'));
    assert.equal(await page.evaluate(() => labelWidth), 260);
    const other = await openPlayer(browser, server.url('role-column'), 'Guest', { audioExpanded: false });
    try {
      await waitFor(other, () => session?.loaded);
      assert.equal(await other.evaluate(() => labelWidth), 180);
      assert.equal(await page.evaluate(() => Object.keys(session).some(k => /role.?column|label.?width/i.test(k))), false);
    } finally { await other.browserContext().close(); }
  });
  test('fractional UI scale uses CSS pixels and expanding a narrow window restores the preferred width', async () => {
    await page.evaluate(() => { layout.top = 220; applyLayout(); localStorage.setItem('dubline_audio_collapsed', '1'); renderTimeline(); });
    for (const zoom of [1, 1.25, 1.5]) {
      await page.setViewport({ width: 1920, height: 1080 });
      await page.evaluate(zoom => { document.body.style.zoom = String(zoom); }, zoom);
      await waitFor(page, () => timelineContainer.clientWidth > 730);
      await page.focus('.ruler-corner .role-column-handle'); await page.keyboard.press('Home');
      const before = await snapshot(); await drag(100 * zoom, '.ruler-corner .role-column-handle');
      assert.equal(await page.evaluate(() => labelWidth), 280, 'CSS pixel delta at zoom ' + zoom);
      assert.deepEqual(await snapshot(), before);
      await page.focus('.ruler-corner .role-column-handle'); await page.keyboard.press('End');
      assert.equal(await page.evaluate(() => labelWidth), 400);
      await page.setViewport({ width: 800, height: 900 });
      await waitFor(page, () => { const b = timelineContainer.getBoundingClientRect(), scale = b.width / timelineContainer.offsetWidth; const visible = (Math.min(innerWidth, b.right) - Math.max(0, b.left)) / scale; return labelWidth === Math.max(180, Math.min(400, Math.floor(Math.min(visible, timelineContainer.clientWidth) * .55))); });
      assert.equal(await page.evaluate(() => localStorage.getItem('dubline_role_column_width')), '400');
      await page.setViewport({ width: 1920, height: 1080 }); await waitFor(page, () => labelWidth === 400);
    }
    await page.evaluate(() => { document.body.style.zoom = ''; });
  });
  test('redrawn roles retain edge handles, normal time clicks still work, double click resets only the column', async () => {
    await page.evaluate(() => { layout.top = 300; applyLayout(); timelineContainer.scrollLeft = 0; renderTimeline(); });
    await page.focus('.ruler-corner .role-column-handle'); await page.keyboard.press('Home');
    await drag(120, '.ruler-corner .role-column-handle');
    const box = await page.$eval('.ruler-ticks', n => { const b = n.getBoundingClientRect(); return { x: b.x + 2 * pxPerSec, y: b.y + b.height / 2 }; });
    await page.mouse.click(box.x, box.y); await waitFor(page, () => Math.abs(video.currentTime - 2) < .03);
    const before = await snapshot();
    await page.click('.ruler-corner .role-column-handle', { count: 2 });
    assert.equal(await page.evaluate(() => labelWidth), 180);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(page.errors, []);
  });
});
