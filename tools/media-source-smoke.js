// Reused by the production Electron smoke, with real file inputs and server state.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { waitFor } = require('../e2e/helpers');
module.exports = async function mediaSourceSmoke(page, directory) {
  await page.evaluate(() => { localStorage.setItem('dubline_audio_collapsed', '0'); renderTimeline(); });
  await waitFor(page, () => session.audioTracks?.length && !session.audioTracksPending && document.querySelectorAll('.studio-audio-row').length === 3);
  const before = await page.evaluate(() => ({ id: session.activeSessionId, lines: JSON.stringify(session.lines) }));
  const bytes = Buffer.from(await page.evaluate(async () => [...new Uint8Array(await (await fetch(session.backingUrl)).arrayBuffer())]));
  const filename = path.join(directory, 'Native background.wav'); fs.writeFileSync(filename, bytes);
  await page.click('#backingRemoveBtn'); await waitFor(page, () => document.querySelector('dialog[open]')); await page.click('#textPromptSave');
  await waitFor(page, () => !session.backingUrl && document.querySelectorAll('.studio-audio-row').length === 2);
  assert.deepEqual(await page.$$eval('.studio-channel-head b', nodes => nodes.map(node => node.textContent)), ['Background / M&E', 'Dub']);
  await (await page.$('#backingSourceInput')).uploadFile(filename);
  await waitFor(page, () => session.audioMetadata?.backing?.name === 'Native background.wav' && document.querySelectorAll('.studio-audio-row').length === 3);
  assert.deepEqual(await page.evaluate(() => ({ id: session.activeSessionId, lines: JSON.stringify(session.lines) })), before);
  await waitFor(page, () => [...document.querySelectorAll('.studio-wave-status')].every(node => !/loading/i.test(node.textContent)));
  await page.focus('#volOriginal');
  const geometry = await page.evaluate(() => {
    const focused = document.activeElement, canvases = [...document.querySelectorAll('.studio-audio-row canvas')];
    for (const zoom of [40, 75, 90, 55]) { setTimelineZoom(zoom); cancelAnimationFrame(zoomFrame); renderTimeline(); }
    return { focused: document.activeElement === focused, canvases: canvases.every(canvas => canvas.isConnected), picker: trackPicker.closest('.studio-audio-sources') !== null };
  });
  assert.deepEqual(geometry, { focused: true, canvases: true, picker: true });
  console.log('Native background add/remove and waveform/focus retention passed; lines/takes unchanged.');
};
