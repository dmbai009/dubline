// Local listening artifacts only. The input is never sent to another service.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { startServer, launchBrowser, openPlayer, loadFixture } = require('../e2e/helpers');
(async () => {
  const input = process.argv[2]; if (!input) throw Error('Usage: node tools/rnnoise-audition.js <local speech WAV>');
  const directory = path.resolve(process.argv[3] || 'audit/rnnoise/audition'); fs.mkdirSync(directory, { recursive: true });
  let server, browser;
  try {
    server = await startServer(); fs.copyFileSync(path.resolve(input), path.join(server.dirs.uploads, 'listening.wav'));
    browser = await launchBrowser(server.port); const page = await openPlayer(browser, server.url('audition'), 'Listener'); await loadFixture(page);
    const result = await page.evaluate(async () => {
      const bytes = await (await fetch('/uploads/listening.wav')).arrayBuffer(), decoder = new AudioContext({ sampleRate: 48000 });
      const raw = await decoder.decodeAudioData(bytes); await decoder.close();
      const wet = await DublineNoiseAudio.wet(raw), module = await import('/vendor/rnnoise/rnnoise.js'), api = await module.Rnnoise.load();
      const reference = raw.getChannelData(0), expected = new Float32Array(raw.length), state = api.createDenoiseState();
      try {
        for (let p = 0; p < Math.ceil((raw.length + 960 + 64) / 480) * 480; p += 480) {
          const frame = new Float32Array(480); for (let j = 0; j < 480; j++) frame[j] = (reference[p+j] || 0) * 32768;
          state.processFrame(frame); for (let j = 0; j < 480; j++) if (p+j >= 960 && p+j-960 < raw.length) expected[p+j-960] = frame[j] / 32768;
        }
      } finally { state.destroy(); }
      let difference = 0; for (let i = 0; i < raw.length; i++) difference = Math.max(difference, Math.abs(expected[i]-wet.getChannelData(0)[i]));
      const variants = [];
      for (const percent of [0,25,50,60,75,100]) {
        const mixed = DublineNoiseAudio.mix(raw, wet, percent/100);
        variants.push({ percent, bytes: [...new Uint8Array(audioBufferToWav(mixed))] });
      }
      return { variants, independentReferenceMaximumDifference: difference, samples: raw.length, sampleRate: raw.sampleRate, channels: raw.numberOfChannels, metrics: DublineNoiseAudio.stats().last };
    });
    assert.equal(result.independentReferenceMaximumDifference, 0);
    for (const { percent, bytes } of result.variants) fs.writeFileSync(path.join(directory, `speech-${percent}.wav`), Buffer.from(bytes));
    delete result.variants; fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { await browser?.close(); await server?.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
