const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, claimAndSelect, waitFor } = require('./helpers');

describe('recording and stem export audit regressions', { skip: skipReason, timeout: 120000 }, () => {
  let server, browser, page, index = 0;
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  beforeEach(async () => {
    page = await openPlayer(browser, server.url(`media-audit-${++index}`), 'Alice');
    await loadFixture(page); await claimAndSelect(page, 1);
    await waitFor(page, () => video.readyState >= 2);
  });
  afterEach(async () => { await page?.browserContext().close(); });

  for (const start of [0, 3]) test(`delayed capture/playback at ${start}s uploads the actual aligned start, including held preparation`, async () => {
    const result = await page.evaluate(async start => {
      const line = session.lines.find(line => line.id === 1); line.start = start; line.end = start + 2;
      preRollSeconds = start === 0 ? 5 : 0;
      const NativeRecorder = MediaRecorder, originalPlay = video.play, originalSubmit = submitTake, originalDecode = decodeAudio;
      let captureAt, playingAt, playingTime, receive, entered, release;
      const uploaded = new Promise(resolve => { receive = resolve; });
      const decoding = new Promise(resolve => { entered = resolve; });
      const decodeGate = new Promise(resolve => { release = resolve; });
      window.MediaRecorder = class extends NativeRecorder {
        start(...args) {
          this.addEventListener('start', () => { captureAt = performance.now(); }, { once: true });
          setTimeout(() => super.start(...args), 200);
        }
      };
      video.play = async function() { await new Promise(resolve => setTimeout(resolve, 450)); return originalPlay.call(this); };
      const playing = () => { playingAt = performance.now(); playingTime = video.currentTime; };
      video.addEventListener('playing', playing, { once: true });
      submitTake = async entry => { const accepted = await originalSubmit(entry); receive({ entry, accepted }); return accepted; };
      decodeAudio = async bytes => { entered(); await decodeGate; return originalDecode(bytes); };
      try {
        const requestedAt = performance.now();
        await handleStudioRecord(1);
        const deadline = performance.now() + 8000;
        while ((!playingAt || recordState !== 'recording') && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        if (!playingAt) throw new Error('Playback did not start');
        await new Promise(resolve => setTimeout(resolve, 180));
        const aligned = currentRecordingStartTime;
        finishRecording(); await decoding;
        currentRecordingStartTime = 999; release();
        const { entry, accepted } = await uploaded;
        const saved = await new Promise(resolve => socket.emit('editor_resync', {}, resolve));
        return { actual: entry.audioStart, saved: saved.session.lines.find(line => line.id === 1).audioStart, accepted,
          expected: playingTime - (playingAt - captureAt) / 1000, planned: start - preRollSeconds, aligned, captureDelay: captureAt - requestedAt };
      } finally {
        release(); finishRecording({ discard: true });
        window.MediaRecorder = NativeRecorder; video.play = originalPlay; submitTake = originalSubmit; decodeAudio = originalDecode;
        video.removeEventListener('playing', playing);
      }
    }, start);
    assert.ok(result.captureDelay >= 180, JSON.stringify(result));
    assert.ok(Math.abs(result.actual - result.expected) < 0.04, JSON.stringify(result));
    assert.ok(result.planned - result.actual > 0.35, JSON.stringify(result));
    assert.equal(result.actual, result.aligned, 'async decoding cannot replace this take timing with a later global value');
    assert.equal(result.accepted, true); assert.equal(result.saved, result.actual, 'the server must not clamp the captured lead-in back to planned time');
  });

  test('multiline captions keep both visible lines and escaped text in the on-screen prompter', async () => {
    const result = await page.evaluate(() => {
      const line = session.lines[0]; line.caption = 'First <b>literal</b> line\nSecond line';
      video.currentTime = line.start + 0.2; updatePrompter();
      const text = document.querySelector('.prompter-text');
      const first = document.createRange(), second = document.createRange();
      first.setStart(text.firstChild, 0); first.setEnd(text.firstChild, 5);
      const at = text.firstChild.textContent.indexOf('Second');
      second.setStart(text.firstChild, at); second.setEnd(text.firstChild, at + 6);
      return { text: text.textContent, hasHtml: !!text.querySelector('b'), first: first.getBoundingClientRect().top, second: second.getBoundingClientRect().top, visible: getComputedStyle(videoPrompter).display };
    });
    assert.equal(result.text, 'First <b>literal</b> line\nSecond line'); assert.equal(result.hasHtml, false);
    assert.equal(result.visible, 'block'); assert.ok(result.second > result.first + 5, JSON.stringify(result));
  });

  test('real stem download uses bounded windows and preserves WAV timing, mix and TSV captions', async () => {
    const result = await page.evaluate(async () => {
      const originalContext = OfflineAudioContext, originalCreate = URL.createObjectURL, originalClick = HTMLAnchorElement.prototype.click;
      const originalTake = requireExportTake, fullStem = renderCharacterStem;
      const buffer = new AudioBuffer({ sampleRate: 48000, numberOfChannels: 1, length: 24000 });
      for (let i = 0; i < buffer.length; i++) buffer.getChannelData(0)[i] = .05 * Math.sin(2 * Math.PI * 330 * i / 48000);
      const contexts = []; let archive;
      const duration = 34.00001;
      Object.defineProperty(video, 'duration', { configurable: true, value: duration });
      session.projectAudio.dub.volume = .5;
      session.lines = [
        { ...session.lines[0], audioUrl: '/audit-stem-one', audioStart: 7.8, character: 'Герой', caption: 'First\nSecond\t"quoted"', trimEnabled: false, volume: .5, pan: -1 },
        { ...session.lines[1], audioUrl: '/audit-stem-two', audioStart: 16.2, character: 'Friend', caption: 'Reply', trimEnabled: false, volume: 1, pan: 1 }
      ];
      requireExportTake = async () => buffer;
      const snapshot = createExportSnapshot(), references = {};
      for (const character of ['Герой', 'Friend']) {
        const rendered = await fullStem(snapshot.takes.filter(line => line.character === character), duration, 48000, snapshot);
        const channel = character === 'Герой' ? 0 : 1, at = character === 'Герой' ? 7.9 : 16.3;
        references[character] = Math.max(...rendered.getChannelData(channel).subarray(Math.round(at * 48000), Math.round(at * 48000) + 4000).map(Math.abs));
      }
      renderCharacterStem = () => { throw new Error('Scene-length stem renderer must not be used'); };
      window.OfflineAudioContext = class extends originalContext {
        constructor(...args) { contexts.push({ frames: args[1], rate: args[2] }); super(...args); }
      };
      URL.createObjectURL = blob => { if (blob.type === 'application/zip') archive = blob; return originalCreate(blob); };
      HTMLAnchorElement.prototype.click = function() {};
      try {
        await downloadReaperStems();
        if (!archive) throw new Error(document.getElementById('stemsStatus').textContent);
        return { bytes: Array.from(new Uint8Array(await archive.arrayBuffer())), contexts, references, duration, busy: stemsExportBusy, disabled: document.getElementById('downloadStemsBtn').disabled };
      } finally {
        window.OfflineAudioContext = originalContext; URL.createObjectURL = originalCreate; HTMLAnchorElement.prototype.click = originalClick;
        requireExportTake = originalTake; renderCharacterStem = fullStem; delete video.duration;
      }
    });
    assert.equal(result.busy, false); assert.equal(result.disabled, false);
    assert.equal(result.contexts.length, 10); assert.ok(result.contexts.every(ctx => ctx.frames <= 10 * ctx.rate));
    const zip = new AdmZip(Buffer.from(result.bytes)); assert.equal(zip.test(), true);
    const wavs = zip.getEntries().filter(entry => entry.entryName.endsWith('.wav')); assert.equal(wavs.length, 2);
    const expectedFrames = Math.ceil(result.duration * 48000);
    for (const entry of wavs) {
      const wav = entry.getData(); assert.equal(wav.length, 44 + expectedFrames * 4);
      assert.equal(wav.readUInt32LE(40), expectedFrames * 4);
      const peak = (at, channel, frames = 4000) => {
        let max = 0;
        for (let i = Math.round(at * 48000); i < Math.round(at * 48000) + frames; i++) max = Math.max(max, Math.abs(wav.readInt16LE(44 + i * 4 + channel * 2)) / 32768);
        return max;
      };
      if (entry.entryName.includes('Герой')) {
        assert.equal(peak(7, 0), 0); assert.ok(Math.abs(peak(7.9, 0) - result.references['Герой']) < 2 / 32768, `left peak ${peak(7.9, 0)}`);
        assert.ok(peak(8.05, 0) > .01, 'no dropout at the eight-second window boundary'); assert.equal(peak(7.9, 1), 0);
      } else {
        assert.equal(peak(15, 1), 0); assert.ok(Math.abs(peak(16.3, 1) - result.references.Friend) < 2 / 32768); assert.equal(peak(16.3, 0), 0);
      }
    }
    assert.match(zip.readAsText('timeline.tsv'), /Герой\t7\.800\t1\t"First\nSecond\t""quoted"""/);
    assert.deepEqual(page.errors, []);
  });
});
