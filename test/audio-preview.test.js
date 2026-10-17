const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const elements = [];
  class Audio {
    constructor() { elements.push(this); }
    play() { return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); }
    pause() { this.reject?.(Object.assign(new Error('Playback interrupted'), { name: 'AbortError' })); }
  }
  const window = { Audio };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/audio'), 'utf8'), { window, Audio, setTimeout, clearTimeout });
  const controller = window.DublineAudio.createController({ getVolumes: () => ({ recorded: 1, isMuted: false }) });
  return { controller, elements };
}

test('stopping or replacing a pending HTML preview consumes only its cancelled playback', async () => {
  const { controller, elements } = fixture();
  const first = controller.playAudio('/first.wav');
  await Promise.resolve();
  const second = controller.playAudio('/second.wav');
  await Promise.resolve();
  await first;
  controller.stopPreview();
  await second;
  assert.equal(elements.length, 2);
});

test('a current HTML preview still reports genuine playback errors', async () => {
  const { controller, elements } = fixture();
  const pending = controller.playAudio('/broken.wav');
  await Promise.resolve();
  const error = new Error('Decoder unavailable');
  elements[0].reject(error);
  await assert.rejects(pending, value => value === error);
});
