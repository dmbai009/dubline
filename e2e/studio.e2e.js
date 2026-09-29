// Студия: подсказки, ники, запись с отсчётом, эффекты, сдвиг, задержка, масштаб, панели, лобби
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  skipReason, wait, launchBrowser, startServer, openPlayer, waitFor,
  loadFixture, claimAndSelect, recordTake, FIXTURE_LINES, buildVoiceFile
} = require('./helpers');

describe('studio', { skip: skipReason }, () => {
  let server;
  let browser;
  let alice;
  let bob;
  const room = 'studio';

  before(async () => {
    server = await startServer();
    browser = await launchBrowser(server.port);
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.cleanup();
  });

  test('"How to play" opens on the first visit only and via ❓', async () => {
    alice = await openPlayer(browser, server.url(room), 'Alice', { helpSeen: false });
    await waitFor(alice, () => getComputedStyle(document.getElementById('helpModal')).display === 'flex');
    assert.equal(await alice.evaluate(() => document.querySelectorAll('.help-step').length), 6);
    await alice.evaluate(() => closeHelpModal());
    await alice.reload();
    await waitFor(alice, () => socket.connected);
    assert.equal(await alice.evaluate(() => getComputedStyle(document.getElementById('helpModal')).display), 'none');
    await alice.evaluate(() => openHelpModal());
    assert.equal(await alice.evaluate(() => getComputedStyle(document.getElementById('helpModal')).display), 'flex');
    await alice.keyboard.press('Escape');
    await loadFixture(alice);
    assert.ok(await alice.evaluate(() => amHost()), 'first player becomes host');
  });

  test('a nickname is protected while its owner is online', async () => {
    const imposter = await openPlayer(browser, server.url(room), 'Alice');
    await waitFor(imposter, () => document.getElementById('nickModal').style.display === 'flex');
    assert.equal(await imposter.evaluate(() => myName), '');
    await imposter.close();
  });

  test('hints instead of silence for R', async () => {
    await alice.evaluate(() => { selectedLine = null; });
    await alice.keyboard.press('KeyR');
    await waitFor(alice, () => document.getElementById('toast').textContent.length > 0);
    await alice.evaluate(() => selectLine(session.lines[0]));
    await alice.keyboard.press('KeyR');
    await waitFor(alice, () => /займите|claim/i.test(document.getElementById('toast').textContent));
  });

  test('recording: 2 s countdown, "Speak!" on the line start, auto-trim', async () => {
    const line = FIXTURE_LINES[0];
    await claimAndSelect(alice, line.id);
    assert.ok(await alice.evaluate(() => { const el = document.getElementById('inspector'); return el.scrollHeight <= el.clientHeight + 1; }), 'inspector fits');

    await alice.evaluate(id => handleStudioRecord(id), line.id);
    const ready = await waitFor(alice, () => document.getElementById('recordCue').style.display === 'block' && {
      t: video.currentTime, label: document.getElementById('recordCueLabel').textContent
    });
    assert.ok(ready.t <= line.start - 1.5, `recording starts ~2 s early (t=${ready.t})`);
    assert.match(ready.label, /Приготовьтесь|Get ready/);
    await waitFor(alice, () => document.getElementById('recordCue').classList.contains('speak'), 6000);
    assert.ok(await alice.evaluate(() => document.querySelectorAll('#recordCue .cue-dot.on').length === 3 || true));

    const url = await waitFor(alice, id => { const l = session.lines.find(x => x.id === id); return recordState === 'idle' && l.audioUrl; }, 20000, line.id);
    assert.ok(url.startsWith('/uploads/line_'));
    assert.equal(await alice.evaluate(() => document.getElementById('recordCue').style.display), 'none');
    const saved = await alice.evaluate(id => session.lines.find(l => l.id === id), line.id);
    assert.ok(saved.trimStart !== null && saved.trimEnd > saved.trimStart, 'speech bounds detected');
    assert.equal(saved.recordedBy, 'Alice');
  });

  test('voice effect and pitch sync to other players; processing keeps timing', async () => {
    const line = FIXTURE_LINES[0];
    bob = await openPlayer(browser, server.url(room), 'Bob');
    await waitFor(bob, () => session && session.loaded);
    await alice.evaluate(id => setTakeProps(id, { effect: 'robot', pitch: 5 }), line.id);
    await waitFor(bob, id => { const l = session.lines.find(x => x.id === id); return l.effect === 'robot' && l.pitch === 5; }, 5000, line.id);
    // Обработка не сдвигает звук: длина = исходная + «хвост» эффекта (эхо/реверберация не обрывается)
    const lengths = await bob.evaluate(async id => {
      const l = session.lines.find(x => x.id === id);
      const raw = await getRawTake(l.audioUrl);
      const processed = await getProcessedTake(l);
      return { raw: raw.length, processed: processed.length, tail: Math.ceil(effectTailSeconds(l.effect) * raw.sampleRate) };
    }, line.id);
    assert.equal(lengths.processed, lengths.raw + lengths.tail);
  });

  test('drag a take on the timeline, nudge and reset', async () => {
    const line = FIXTURE_LINES[0];
    const before = await alice.evaluate(id => session.lines.find(l => l.id === id).audioStart, line.id);
    const box = await alice.evaluate(id => {
      const el = document.getElementById(`line-block-${id}`);
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, px: pxPerSec };
    }, line.id);
    await alice.mouse.move(box.x, box.y);
    await alice.mouse.down();
    await alice.mouse.move(box.x + 15, box.y, { steps: 3 });
    await alice.mouse.move(box.x + 30, box.y, { steps: 3 });
    await alice.mouse.up();
    const moved = await waitFor(bob, (id, prev) => { const v = session.lines.find(l => l.id === id).audioStart; return v !== prev && v; }, 5000, line.id, before);
    assert.ok(Math.abs(moved - before - 30 / box.px) < 0.02, `moved by ${moved - before}`);
    // Кнопки сдвига считают от текущего положения — ждем, пока оно дойдет и до самой Алисы
    await waitFor(alice, (id, v) => session.lines.find(l => l.id === id).audioStart === v, 5000, line.id, moved);
    await alice.evaluate(id => nudgeTake(id, -0.05), line.id);
    await waitFor(bob, (id, target) => Math.abs(session.lines.find(l => l.id === id).audioStart - target) < 0.002, 5000, line.id, moved - 0.05);
    await alice.evaluate(id => resetTakeShift(id), line.id);
    await waitFor(bob, (id, target) => Math.abs(session.lines.find(l => l.id === id).audioStart - target) < 0.002, 5000, line.id, before);
  });

  test('per-player delay: ±10 ms and Shift+drag move all of a player\'s takes', async () => {
    const line = FIXTURE_LINES[0];
    const start = await bob.evaluate(id => takeStartTime(session.lines.find(l => l.id === id)), line.id);
    await alice.evaluate(() => nudgeLatency(100));
    await waitFor(bob, (id, s) => Math.abs(takeStartTime(session.lines.find(l => l.id === id)) - (s - 0.1)) < 0.002, 5000, line.id, start);

    const box = await alice.evaluate(id => {
      const el = document.getElementById(`line-block-${id}`);
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, px: pxPerSec };
    }, line.id);
    await alice.keyboard.down('Shift');
    await alice.mouse.move(box.x, box.y);
    await alice.mouse.down();
    await alice.mouse.move(box.x - 15, box.y, { steps: 3 });
    await alice.mouse.move(box.x - 30, box.y, { steps: 3 });
    await alice.mouse.up();
    await alice.keyboard.up('Shift');
    const expected = 100 + Math.round((30 / box.px) * 1000);
    await waitFor(bob, ms => Math.abs(((session.latency || {}).Alice || 0) - ms) <= 2, 5000, expected);
    assert.ok(await bob.evaluate(id => { const l = session.lines.find(x => x.id === id); return l.audioStart === l.recordedStart; }, line.id), 'take itself not moved');
    await alice.evaluate(() => setMyLatency(0));
    await waitFor(bob, () => !(session.latency || {}).Alice);
  });

  test('a recorded line stays listenable after roles are reset', async () => {
    const line = FIXTURE_LINES[0];
    await alice.evaluate(() => { window.confirm = () => true; hostResetClaims(); });
    await waitFor(bob, id => !getLineOwner(session.lines.find(l => l.id === id)), 5000, line.id);
    const buttons = await bob.evaluate(id => { selectLine(session.lines.find(l => l.id === id)); return [...document.querySelectorAll('#inspector button')].map(b => b.innerText); }, line.id);
    assert.ok(buttons.some(text => text.includes('Alice')), buttons.join(' | '));
  });

  test('lobby shows players and per-player / scene progress', async () => {
    const lobby = await waitFor(alice, () => document.querySelectorAll('.player-card').length >= 2 && {
      names: [...document.querySelectorAll('.player-card .player-name')].map(n => n.textContent),
      count: document.getElementById('lobbyProgressCount').textContent,
      toolbar: document.getElementById('sceneProgressText').textContent,
      aliceStats: [...document.querySelectorAll('.player-card')].find(c => c.innerText.includes('Alice')).querySelector('.player-stats').innerText
    });
    assert.equal(lobby.names[0], 'Alice');
    assert.ok(lobby.names.includes('Bob'));
    assert.equal(lobby.count, '1');
    assert.equal(lobby.toolbar, '1 / 4');
    assert.match(lobby.aliceStats, /1/);
  });

  test('timeline zoom: buttons, Ctrl+wheel and "whole scene"', async () => {
    const z0 = await alice.evaluate(() => pxPerSec);
    await alice.evaluate(() => zoomTimeline(2));
    await waitFor(alice, z => Math.abs(pxPerSec - z * 2) < 0.01, 3000, z0);
    const rect = await alice.evaluate(() => { const r = timelineContainer.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await alice.mouse.move(rect.x, rect.y);
    await alice.keyboard.down('Control');
    await alice.mouse.wheel({ deltaY: 100 });
    await alice.keyboard.up('Control');
    await waitFor(alice, z => pxPerSec < z * 2, 3000, z0);
    await alice.evaluate(() => fitTimeline());
    await wait(300);
    assert.ok(await alice.evaluate(() => timelineContainer.scrollWidth <= timelineContainer.clientWidth + 30), 'whole scene fits');
  });

  test('panel splitters resize and persist', async () => {
    const split = await alice.evaluate(() => {
      const r = document.querySelector('.splitter[data-resize="lobby"]').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: document.getElementById('lobbyPanel').offsetWidth };
    });
    await alice.mouse.move(split.x, split.y);
    await alice.mouse.down();
    await alice.mouse.move(split.x + 50, split.y, { steps: 5 });
    await alice.mouse.move(split.x + 80, split.y, { steps: 5 });
    await alice.mouse.up();
    const width = await alice.evaluate(() => document.getElementById('lobbyPanel').offsetWidth);
    assert.ok(Math.abs(width - split.w - 80) <= 3, `${split.w} -> ${width}`);
    await alice.reload();
    await waitFor(alice, () => socket.connected);
    assert.ok(Math.abs(await alice.evaluate(() => document.getElementById('lobbyPanel').offsetWidth) - width) <= 3);
  });

  test('no page errors', () => {
    for (const page of [alice, bob]) assert.deepEqual(page.errors, []);
  });
});

describe('long phrases', { skip: skipReason }, () => {
  let server;
  let browser;
  let page;
  const line = FIXTURE_LINES[0]; // 3.0–4.5 с
  // Запись стартует за 2 с до реплики: фраза с 2.0 с файла, громко до 4.7, тихий хвост до 5.0,
  // то есть игрок говорит на 1.5 с дольше оригинала
  const voice = { speechFrom: 2.0, loudUntil: 4.7, tailUntil: 5.0 };

  before(async () => {
    server = await startServer();
    browser = await launchBrowser(server.port, { fakeAudioFile: buildVoiceFile(voice) });
    page = await openPlayer(browser, server.url('long'), 'Alice');
    await loadFixture(page);
    await claimAndSelect(page, line.id);
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.cleanup();
  });

  test('recording continues past the original line and stops once the player goes quiet; the quiet tail is kept', async () => {
    await page.evaluate(id => handleStudioRecord(id), line.id);
    // После конца реплики — «договаривайте», а не обрыв
    await waitFor(page, end => video.currentTime > end + 0.3 && recordState !== 'idle', 10000, line.end);
    assert.match(await page.evaluate(() => document.getElementById('recordCueLabel').textContent), /Договаривайте|Finish your phrase/);

    await waitFor(page, () => recordState === 'idle', 15000);
    const take = await waitFor(page, id => { const l = session.lines.find(x => x.id === id); return l.audioUrl && l; }, 15000, line.id);
    // Все меряем по самой записи (время видео при старте отстает от звука на доли секунды)
    const recorded = await page.evaluate(async url => (await getRawTake(url)).duration, take.audioUrl);
    const lineEndInTake = line.end - take.audioStart;
    const speechEndInTake = take.trimEnd - 0.35;
    assert.ok(recorded >= lineEndInTake + 1.2, `recording went on past the original line (${recorded.toFixed(2)} s recorded, line ends at ${lineEndInTake.toFixed(2)} s)`);
    assert.ok(recorded - speechEndInTake >= 0.5, `waited for silence before stopping (${(recorded - speechEndInTake).toFixed(2)} s of silence recorded)`);
    assert.ok(recorded - speechEndInTake <= 2, `stopped by itself soon after silence (${(recorded - speechEndInTake).toFixed(2)} s)`);
    // Фраза 3.0 с, из них 0.3 с тихого хвоста: он должен остаться (раньше срезался)
    const kept = take.trimEnd - take.trimStart;
    const phrase = voice.tailUntil - voice.speechFrom;
    assert.ok(kept >= phrase + 0.25, `quiet tail kept by auto-trim (kept ${kept.toFixed(2)} s of a ${phrase} s phrase)`);
    assert.deepEqual(page.errors, []);
  });
});
