const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const model = require('./public/project-audio');

function fixture() {
  const video = new EventTarget(); Object.assign(video, { readyState: 3, currentTime: 4, paused: false, seeking: false, ended: false, error: null, playbackRate: 1, currentSrc: '/video.mp4', buffered: { length: 1, start: () => 0, end: () => 30 }, getAttribute: () => '/video.mp4' });
  let now = 0; const sent = [], listeners = {}, overlay = {}, timers = [];
  const context = { video, session: { loaded: true, activeSessionId: 'one', videoHash: 'hash', videoSize: 42 }, socket: { connected: true, emit: (event, data) => sent.push({ event, data }), on: (event, handler) => { listeners[event] = handler; } },
    document: { createElement: () => Object.assign(overlay, { setAttribute() {} }), querySelector: () => ({ append() {} }) }, window: {}, performance: { now: () => now }, setInterval: fn => timers.push(fn), setTimeout, clearTimeout, t: key => key };
  vm.runInNewContext(fs.readFileSync('public/media-readiness.js', 'utf8'), context);
  const tick = (seconds = .2) => { now += seconds * 1000; video.dispatchEvent(new Event('timeupdate')); };
  return { video, overlay, context, sent, tick, update: listeners.session_updated, latest: () => sent.at(-1)?.data };
}
test('waiting/stalled recover from continuous playback without canplay or playing events', () => {
  for (const event of ['waiting', 'stalled']) {
    const f = fixture(); f.update(); assert.equal(f.latest().state, 'ready');
    f.video.dispatchEvent(new Event(event)); assert.equal(f.latest().state, 'buffering'); assert.equal(f.overlay.hidden, false);
    f.video.currentTime += .2; f.tick(); assert.equal(f.latest().state, 'ready'); assert.equal(f.overlay.hidden, true);
  }
});
test('a seek jump cannot masquerade as recovery and actual decoder failure stays visible', () => {
  const f = fixture(); f.update(); f.video.dispatchEvent(new Event('waiting'));
  f.video.readyState = 2; f.video.seeking = true; f.video.dispatchEvent(new Event('seeking')); f.video.currentTime = 20; f.tick();
  assert.equal(f.latest().state, 'buffering'); f.video.seeking = false; f.video.dispatchEvent(new Event('seeked'));
  assert.equal(f.latest().state, 'buffering'); f.video.currentTime += .2; f.tick(); assert.equal(f.latest().state, 'ready');
  f.video.error = { code: 3 }; f.video.dispatchEvent(new Event('error')); assert.equal(f.latest().state, 'failed');
});
test('stale waiting on a decodable paused player does not invent a buffering failure', () => {
  const f = fixture(); f.video.paused = true; f.update(); f.video.dispatchEvent(new Event('waiting'));
  assert.equal(f.latest().state, 'ready'); assert.equal(f.overlay.hidden, true);
});
test('decodable media keeps actual ongoing download progress visible until transfer completion', () => {
  const f = fixture(); f.update(); f.context.window.updateMediaTransfer({ downloading: true, pct: 42 });
  assert.equal(f.latest().state, 'downloading'); assert.equal(f.latest().pct, 42);
  f.context.window.updateMediaTransfer({ downloading: false, pct: 100 }); assert.equal(f.latest().state, 'ready');
});
test('changing scene or HTTP/P2P source clears stale waiting, transfer and decoder state', () => {
  const f = fixture(); f.update(); f.video.dispatchEvent(new Event('waiting'));
  f.context.session.activeSessionId = 'two'; f.context.window.updateMediaTransfer({ fallback: true, pct: 100 });
  assert.equal(f.latest().sessionId, 'two'); assert.equal(f.latest().state, 'fallback');
  f.video.dispatchEvent(new Event('waiting')); f.video.currentSrc = 'blob:replacement'; f.update(); assert.equal(f.latest().state, 'fallback');
});
test('preparation diagnostics distinguish extraction, source failure, buffering and successful alternatives', () => {
  const session = { videoUrl: '/video', audioTracksError: '/video', videoHasAudio: true, backingUrl: '/backing' };
  const elements = { original: { readyState: 4 }, backing: { readyState: 4 } };
  assert.equal(model.preparationStatus({ ...session, audioTracksError: null, audioTracksPending: true }, { original: { readyState: 0 }, backing: elements.backing }).key, 'tracks.preparing');
  assert.equal(model.preparationStatus(session, elements).key, 'tracks.extractionFailed');
  assert.equal(model.preparationStatus({ ...session, externalOriginalUrl: '/external' }, elements).key, '');
  assert.equal(model.preparationStatus({ ...session, audioTracks: [{ url: '/extracted' }] }, elements).key, '');
  elements.backing.readyState = 1; assert.equal(model.preparationStatus(session, elements).key, 'tracks.buffering');
  elements.backing.error = { code: 4 }; const failed = model.preparationStatus(session, elements);
  assert.equal(failed.key, 'tracks.sourceFailed'); assert.deepEqual(failed.channels, ['backing']); assert.equal(failed.loading, false);
  elements.backing.error = null; elements.backing.readyState = 4;
  assert.equal(model.preparationStatus({ ...session, audioTracksError: '/old' }, elements).key, '');
});
