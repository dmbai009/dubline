// Local listening examples. No microphone, upload, project edits or added noise.
const fs = require('node:fs'), path = require('node:path');
const { startServer, launchBrowser, openPlayer, loadFixture } = require('../e2e/helpers');
(async () => {
  let server, browser;
  const directory = path.resolve('audit/voice-chains/listening'); fs.mkdirSync(directory, { recursive: true });
  try {
    server = await startServer(); browser = await launchBrowser(server.port); const page = await openPlayer(browser, server.url('private-chain-listening'), 'Local listener');
    for (let n = 1; n <= 3; n++) {
      const original = path.resolve(`audit/noise-reduction/voice-${n}-original.wav`); if (!fs.existsSync(original)) continue;
      const outputs = await page.evaluate(async bytes => {
        const raw = await decodeAudio(new Uint8Array(bytes).buffer), item = (type, amount) => ({ id: newUploadId(), type, amount, enabled: true, parameters: {} });
        const robot = item('robot', .65), echo = item('echo', .35);
        const chains = { dry: [], 'robot-echo': [robot, echo], 'echo-robot': [echo, robot], 'telephone-cave': [item('telephone', .75), item('cave', .3)], 'monster-echo': [item('monster', .65), echo], 'radio-radio': [item('radio', .25), item('radio', .65)] };
        const outputs = {};
        for (const [name, effects] of Object.entries(chains)) {
          const buffer = await DublineAudioFx.renderChain(raw, { pitch: 0, effects, tail: effects.reduce((sum, item) => sum + DublineVoiceChain.tail(item), 0) });
          outputs[name] = Array.from(new Uint8Array(audioBufferToWav(buffer)));
        }
        return outputs;
      }, Array.from(fs.readFileSync(original)));
      for (const [name, bytes] of Object.entries(outputs)) fs.writeFileSync(path.join(directory, `voice-${n}-${name}.wav`), Buffer.from(bytes));
    }
    fs.writeFileSync(path.join(directory, 'README.txt'), 'dry = decoded saved voice without voice effects. Other files process that same voice through the named chain. No artificial noise was added. Originals and project data remain unchanged. Compare each chain with dry at the same playback volume. Echo/reverb files contain longer tails.\n');
    await loadFixture(page); await page.evaluate(async () => { await DublineI18n.setLanguage('ru'); DublineVoiceEditor.open('Hero', 'role'); });
    for (const type of ['robot', 'echo', 'telephone']) { await page.select('#fxType', type); await page.click('#fxAdd'); }
    await page.$eval('#fxPitch', node => { node.value = '-3'; node.dispatchEvent(new Event('input')); });
    await page.screenshot({ path: path.join(directory, 'role-editor-midnight-ru.png') });
    await page.setViewport({ width: 640, height: 850 }); await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; document.body.style.zoom = '150%'; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(directory, 'role-editor-light-ru-150.png') });
    await page.evaluate(() => DublineVoiceEditor.close(true));
    console.log('Local dry/ordered-chain comparisons prepared: audit/voice-chains/listening');
  } finally { await browser?.close(); await server?.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
