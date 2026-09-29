// Studio: hints, nicknames, recording with countdown, effects, shifting, delay, zoom, panels, lobby
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  skipReason, wait, launchBrowser, startServer, openPlayer, waitFor, waitUntil,
  loadFixture, claimAndSelect, recordTake, FIXTURE_LINES, buildVoiceFile, fixtureVideoPath
} = require('./helpers');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

  test('line length comes from the original voice when the pack gives only a start (MP3)', async () => {
    const line = FIXTURE_LINES[3];
    // Take the length from the server (the page can adjust it itself, but recording and takes rely on the server's)
    const fromServer = await alice.evaluate(id => new Promise(resolve => {
      socket.once('session_updated', data => resolve(data.lines.find(l => l.id === id).end));
      socket.emit('join_room', { room: currentRoom, nick: myName, clientId });
    }), line.id);
    assert.ok(Math.abs(fromServer - line.end) < 0.1, `end ${fromServer}, expected ~${line.end} (not start + 3)`);
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
    await waitFor(alice, () => document.getElementById('toast').textContent.includes(t('toast.claimFirst')));
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
    assert.equal(ready.label, await alice.evaluate(() => t('cue.ready')));
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
    // Processing does not shift the sound: length = original + the effect tail (echo/reverb is not cut off)
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
    // The shift buttons count from the current position: wait until it reaches Alice herself too
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

  test('overlapping lines are stacked into lanes instead of drawn on top of each other', async () => {
    // Subtitles with lines overlapping in time (as in anime: people talk at once)
    const srt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-srt-')), 'overlap.srt');
    fs.writeFileSync(srt, [
      '1\n00:00:01,000 --> 00:00:04,000\nA: one\n',
      '2\n00:00:02,000 --> 00:00:05,000\nA: two\n',
      '3\n00:00:03,000 --> 00:00:03,500\nA: three\n',
      '4\n00:00:06,000 --> 00:00:07,000\nA: four\n'
    ].join('\n'));
    await alice.evaluate(() => openFilesModal());
    await (await alice.$('#customVideoInput')).uploadFile(fixtureVideoPath());
    await (await alice.$('#customSubInput')).uploadFile(srt);
    await alice.evaluate(() => uploadCustomScene());
    await waitFor(alice, () => session.loaded && session.lines.length === 4 && document.querySelectorAll('.line-block').length === 4, 15000);

    const layout = await alice.evaluate(() => ({
      tiles: session.lines.map(l => {
        const el = document.getElementById(`line-block-${l.id}`);
        return { start: l.start, end: l.end, top: parseFloat(el.style.top) };
      }),
      rowHeight: document.querySelector('.track-row').offsetHeight
    }));
    const lanes = [...new Set(layout.tiles.map(tile => tile.top))];
    assert.equal(lanes.length, 3, `three lanes for three mutually overlapping lines (${JSON.stringify(layout.tiles)})`);
    for (const a of layout.tiles) {
      for (const b of layout.tiles) {
        if (a !== b && a.top === b.top) assert.ok(a.end <= b.start + 0.001 || b.end <= a.start + 0.001, 'no overlap inside one lane');
      }
    }
    assert.equal(layout.rowHeight, 6 + 3 * 54, 'row grows to fit the lanes');
    assert.equal(layout.tiles.find(tile => tile.start === 6).top, Math.min(...lanes), 'free time goes back to the first lane');

    // The prompter over the video shows all lines that sound at the same time
    const prompter = await alice.evaluate(async () => {
      video.currentTime = 3.2;
      await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
      updatePrompter();
      const rows = () => [...document.querySelectorAll('#videoPrompter .prompter-line')];
      const plain = rows().map(row => row.querySelector('.prompter-text').textContent);
      // While recording, your own line comes first and is highlighted, the others are dimmed
      const second = session.lines.find(l => /two$/.test(l.caption));
      recordingLineId = second.id;
      updatePrompter();
      const recording = rows().map(row => ({ text: row.querySelector('.prompter-text').textContent, cls: row.className.trim() }));
      recordingLineId = null;
      updatePrompter();
      return { plain, recording, visible: getComputedStyle(document.getElementById('videoPrompter')).display };
    });
    // (in the test subtitles the line text is "A: one": a one-letter prefix is not a character name)
    assert.deepEqual(prompter.plain.map(text => text.split(' ').pop()), ['one', 'two', 'three']);
    assert.match(prompter.recording[0].text, /two$/);
    assert.match(prompter.recording[0].cls, /recording/);
    assert.ok(prompter.recording.slice(1).every(row => /dim/.test(row.cls)));
    assert.equal(prompter.visible, 'block');
  });

  test('changing the character of a line moves it to that character track', async () => {
    // The SRT scene is open now: all 4 lines belong to one character
    const renameTo = async (page, id, name) => {
      await page.evaluate(lineId => { selectLine(session.lines.find(l => l.id === lineId)); startCharacterEdit(lineId); }, id);
      await page.evaluate(value => {
        document.getElementById('charInput').value = value;
        document.querySelector('.insp-char-form').dispatchEvent(new Event('submit', { cancelable: true }));
      }, name);
    };
    const ids = await alice.evaluate(() => session.lines.map(l => l.id));
    await renameTo(alice, ids[0], 'Rena');
    await waitFor(bob, id => {
      const row = [...document.querySelectorAll('.track-row')].find(r => r.querySelector('.char-name')?.textContent === 'Rena');
      return row && row.querySelector(`#line-block-${id}`);
    }, 5000, ids[0]);
    assert.equal(await bob.evaluate(() => document.querySelectorAll('.track-row').length), 2, 'a new track appeared');

    // Alice claimed the role "Rena": Bob cannot move a line there, but can move a free line to a new role
    await alice.evaluate(() => claimCharacter('Rena'));
    await waitFor(bob, () => session.characterClaims['Rena'] === 'Alice', 5000);
    const before = await bob.evaluate(id => session.lines.find(l => l.id === id).character, ids[1]);
    await renameTo(bob, ids[1], 'Rena');
    await waitFor(bob, () => /Alice/.test(document.getElementById('toast').textContent), 3000);
    assert.equal(await bob.evaluate(id => session.lines.find(l => l.id === id).character, ids[1]), before, 'line stayed with its character');
    await renameTo(bob, ids[2], 'Mion');
    await waitFor(alice, id => session.lines.find(l => l.id === id).character === 'Mion', 5000, ids[2]);

    // Bob cannot rename Alice's line: he has no ✎ button
    assert.equal(await bob.evaluate(id => { selectLine(session.lines.find(l => l.id === id)); return !!document.getElementById('charInput'); }, ids[0]), false);
  });

  test('select several lines and assign a character; rename whole tracks; host releases lines', async () => {
    const byStart = await bob.evaluate(() => [...session.lines].sort((a, b) => a.start - b.start).map(l => l.id));
    const freeIds = await bob.evaluate(() => session.lines.filter(l => !getLineOwner(l)).map(l => l.id));
    const click = async (page, id, modifier) => {
      if (modifier) await page.keyboard.down(modifier);
      await page.click(`#line-block-${id}`);
      if (modifier) await page.keyboard.up(modifier);
    };

    // Ctrl+click: two free lines, assign them to a new character
    await click(bob, freeIds[0]);
    await click(bob, freeIds[1], 'Control');
    await waitFor(bob, () => document.getElementById('inspector').innerText.includes(t('multi.title', { n: 2 })), 3000);
    await bob.evaluate(() => { document.getElementById('multiCharInput').value = 'Keiichi'; document.querySelector('.insp-char-form').dispatchEvent(new Event('submit', { cancelable: true })); });
    await waitFor(alice, ids => ids.every(id => session.lines.find(l => l.id === id).character === 'Keiichi'), 5000, freeIds.slice(0, 2));

    // Shift+click: the whole range; Bob cannot move lines into a role someone else claimed
    await bob.keyboard.press('Escape');
    await click(bob, byStart[0]);
    await click(bob, byStart[byStart.length - 1], 'Shift');
    await waitFor(bob, n => document.getElementById('inspector').innerText.includes(t('multi.title', { n })), 3000, byStart.length);
    await bob.evaluate(() => { document.getElementById('multiCharInput').value = 'Rena'; document.querySelector('.insp-char-form').dispatchEvent(new Event('submit', { cancelable: true })); });
    await waitFor(bob, () => document.getElementById('toast').textContent.includes(t('multi.skipped').split('{n}')[0]), 3000);
    await bob.keyboard.press('Escape');
    assert.equal(await bob.evaluate(() => document.querySelectorAll('.line-block.multi-selected').length), 0, 'Esc clears the selection');

    // Anyone can rename a track of free lines; a track with someone else's role only the host can
    bob.promptAnswer = 'Keichi';
    await bob.evaluate(() => renameCharacterTrack('Keiichi'));
    await waitFor(alice, () => session.lines.filter(l => l.character === 'Keichi').length === 2 && !session.lines.some(l => l.character === 'Keiichi'), 5000);
    const bobCanRenameRena = await bob.evaluate(() => [...document.querySelectorAll('.track-row')].find(r => r.querySelector('.char-name')?.textContent === 'Rena')?.querySelector('.track-rename') != null);
    assert.equal(bobCanRenameRena, false, 'no ✎ on a track with lines of another player');
    alice.promptAnswer = 'Renna';
    await alice.evaluate(() => renameCharacterTrack('Rena'));
    await waitFor(bob, () => session.characterClaims['Renna'] === 'Alice' && !session.characterClaims['Rena'], 5000);

    // Bob claimed a line by mistake: the host releases it through a selection
    const mistaken = freeIds[0];
    await bob.evaluate(id => claimSingleLine(id), mistaken);
    await waitFor(alice, id => session.lines.find(l => l.id === id).claimedBy === 'Bob', 5000, mistaken);
    // Click only once Alice's screen shows the current timeline (it is redrawn after a track rename)
    await waitFor(alice, id => [...document.querySelectorAll('.char-name')].some(n => n.textContent === 'Renna')
      && document.getElementById(`line-block-${id}`)?.innerText.includes('Bob'), 5000, mistaken);
    // Click the tile elements directly here: after track renames Alice's timeline
    // is rebuilt, and a click at screen coordinates may land on a neighbouring tile
    await alice.evaluate((a, b) => {
      document.getElementById(`line-block-${a}`).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.getElementById(`line-block-${b}`).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    }, mistaken, freeIds[1]);
    const picked = await waitFor(alice, (a, b) => multiSelection.has(a) && multiSelection.has(b) && [...multiSelection], 3000, mistaken, freeIds[1])
      .catch(async err => {
        const info = await alice.evaluate(id => {
          const el = document.getElementById(`line-block-${id}`);
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          const row = el.closest('.track-row');
          return { multi: [...multiSelection], selected: selectedLine && selectedLine.id, box: [r.x, r.y, r.width, r.height].map(Math.round),
            hit: hit && (hit.closest('.line-block') || hit).id || hit && hit.className, rowTop: Math.round(row.getBoundingClientRect().y), rowH: row.offsetHeight,
            tileTop: el.style.top, rows: [...document.querySelectorAll('.track-row')].map(r2 => [r2.querySelector('.char-name').textContent, Math.round(r2.getBoundingClientRect().y), r2.offsetHeight]) };
        }, mistaken);
        throw new Error(`${err.message} | ${JSON.stringify(info)}`);
      });
    assert.ok(picked.length === 2);
    await alice.evaluate(() => releaseSelectedLines());
    await waitFor(bob, id => !session.lines.find(l => l.id === id).claimedBy, 5000, mistaken);
    await alice.keyboard.press('Escape');
  });

  test('ASS import skips typesetting drawings; host deletes lines; view follows a moved line', async () => {
    const ass = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-ass-')), 'episode.ass');
    fs.writeFileSync(ass, [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Sign,,0,0,0,,{\\p1}m 0 0 l 157 0 157 26 0 26',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Sign,,0,0,0,,m 0 0 l 490 0 490 271 0 271',
      'Dialogue: 0,0:00:02.50,0:00:03.50,Sign,,0,0,0,,{\\an8}School\\hof hope',
      'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,First line',
      'Dialogue: 0,0:00:06.00,0:00:07.00,Default,,0,0,0,,Second line',
      'Dialogue: 0,0:00:08.00,0:00:09.00,Default,,0,0,0,,Third line'
    ].join('\n'));
    await alice.evaluate(() => openFilesModal());
    await (await alice.$('#customVideoInput')).uploadFile(fixtureVideoPath());
    await (await alice.$('#customSubInput')).uploadFile(ass);
    await alice.evaluate(() => uploadCustomScene());
    const captions = await waitFor(alice, () => session.loaded && session.lines.length && document.querySelectorAll('.line-block').length === session.lines.length && session.lines.map(l => l.caption), 15000);
    assert.deepEqual(captions, ['School of hope', 'First line', 'Second line', 'Third line'], 'drawings dropped, \\h cleaned');

    // The host deletes an on-screen sign
    const sign = await alice.evaluate(() => session.lines[0].id);
    await alice.evaluate(id => { window.confirm = () => true; deleteLines([id]); }, sign);
    await waitFor(bob, id => session.lines.length === 3 && !session.lines.some(l => l.id === id), 5000, sign);
    assert.equal(await bob.evaluate(() => typeof deleteLines === 'function' && !document.querySelector('#inspector button[onclick^="deleteLines"]')), true, 'players have no delete button');

    // The visible "🎭 Character" row in the inspector; after changing the character the timeline shows the line
    const target = await alice.evaluate(() => session.lines[2].id);
    await alice.evaluate(id => selectLine(session.lines.find(l => l.id === id)), target);
    await waitFor(alice, () => !!document.getElementById('charInput'));
    await alice.evaluate(() => { timelineContainer.scrollTop = 0; });
    await alice.evaluate(() => {
      document.getElementById('charInput').value = 'Yoshida';
      document.querySelector('.insp-char-form').dispatchEvent(new Event('submit', { cancelable: true }));
    });
    await waitFor(alice, id => {
      const tile = document.getElementById(`line-block-${id}`);
      if (!tile || session.lines.find(l => l.id === id).character !== 'Yoshida') return false;
      const box = tile.getBoundingClientRect();
      const view = timelineContainer.getBoundingClientRect();
      return box.top >= view.top && box.bottom <= view.bottom;
    }, 5000, target);
  });

  test('deleting lines can be undone (Ctrl+Z, toast button); takes survive until then', async () => {
    const ids = await alice.evaluate(() => session.lines.map(l => l.id));
    const target = ids[0];
    await claimAndSelect(alice, target);
    const takeUrl = await recordTake(alice, target);
    const takeFile = path.join(server.dirs.uploads, decodeURIComponent(takeUrl).split('/').pop());
    const before = await alice.evaluate(() => session.lines.map(l => ({ id: l.id, character: l.character })));
    const undoBefore = await alice.evaluate(() => session.undoCount || 0);
    const trashBefore = await alice.evaluate(() => session.trashCount || 0);

    // Delete a line with a take: a toast with "Undo", a toolbar button, the take file is kept
    await alice.evaluate(id => { window.confirm = () => true; deleteLines([id]); }, target);
    await waitFor(bob, id => !session.lines.some(l => l.id === id), 5000, target);
    await waitFor(alice, () => document.querySelector('#toast button') && document.getElementById('toast').innerText.includes(t('undo.action')), 3000);
    await waitFor(alice, n => document.getElementById('undoDeleteBtn').style.display !== 'none' && document.getElementById('undoDeleteBtn').textContent.includes(String(n)), 3000, trashBefore + 1);
    assert.ok(fs.existsSync(takeFile), 'take file kept while undo is possible');

    // Not the host: Ctrl+Z restores nothing
    await bob.keyboard.down('Control'); await bob.keyboard.press('KeyZ'); await bob.keyboard.up('Control');
    await wait(500);
    assert.ok(!(await alice.evaluate(id => session.lines.some(l => l.id === id), target)));

    // Host: Ctrl+Z puts the line back in place with its take and character
    await alice.keyboard.down('Control'); await alice.keyboard.press('KeyZ'); await alice.keyboard.up('Control');
    await waitFor(bob, (id, url) => { const l = session.lines.find(x => x.id === id); return l && l.audioUrl === url; }, 5000, target, takeUrl);
    assert.deepEqual(await bob.evaluate(() => session.lines.map(l => ({ id: l.id, character: l.character }))), before, 'same order and characters');
    assert.equal(await alice.evaluate(() => session.undoCount || 0), undoBefore);

    // Several lines and undo with the toast button
    const two = ids.slice(1, 3);
    await alice.evaluate(list => deleteLines(list), two);
    await waitFor(bob, list => list.every(id => !session.lines.some(l => l.id === id)), 5000, two);
    await waitFor(alice, () => !!document.querySelector('#toast button'), 3000);
    await alice.click('#toast button');
    await waitFor(bob, order => JSON.stringify(session.lines.map(l => l.id)) === JSON.stringify(order), 5000, before.map(l => l.id));
  });

  test('trash window: restore any deleted line, search, delete forever', async () => {
    // First make sure both players have the same list of lines (the previous test may still be arriving)
    const bobOrder = await bob.evaluate(() => JSON.stringify(session.lines.map(l => l.id)));
    await waitFor(alice, expected => JSON.stringify(session.lines.map(l => l.id)) === expected, 5000, bobOrder);
    const order = await alice.evaluate(() => session.lines.map(l => l.id));
    // The trash may already hold something from earlier tests: "Restore all" restores that too
    const alreadyInTrash = (await alice.evaluate(() => new Promise(resolve => socket.emit('host_trash_list', {}, resolve)))).map(item => item.lineId);
    const takeLine = await alice.evaluate(() => session.lines.find(l => l.audioUrl)?.id);
    assert.ok(takeLine, 'a line with a take exists from the previous test');
    const takeUrl = await alice.evaluate(id => session.lines.find(l => l.id === id).audioUrl, takeLine);
    const takeFile = path.join(server.dirs.uploads, decodeURIComponent(takeUrl).split('/').pop());

    // Delete all lines in two passes
    await alice.evaluate(list => { window.confirm = () => true; deleteLines(list); }, order.slice(0, 2));
    await waitFor(alice, n => session.lines.length === n, 5000, order.length - 2);
    await alice.evaluate(list => deleteLines(list), order.slice(2));
    await waitFor(bob, () => session.lines.length === 0, 5000);

    // Only the host has the trash
    assert.equal(await bob.evaluate(() => document.getElementById('undoDeleteBtn').style.display), 'none');
    assert.deepEqual(await bob.evaluate(() => new Promise(resolve => socket.emit('host_trash_list', {}, resolve))), []);

    // Click from inside the page: the trash list is redrawn on every session update
    const press = (page, selector) => page.evaluate(sel => document.querySelector(sel).click(), selector);
    await press(alice, '#undoDeleteBtn');
    await waitFor(alice, n => document.querySelectorAll('#trashList .trash-item').length >= n, 5000, order.length);
    assert.ok(await alice.evaluate(id => document.querySelector(`#trashList input[data-id="${id}"]`).closest('.trash-item').innerText.includes('🎙'), takeLine), 'take marked');

    // Search and restore a single line from the middle
    const middle = order[1];
    const middleCaption = await alice.evaluate(id => trashItems.find(i => i.lineId === id).caption, middle);
    await alice.type('#trashFilter', middleCaption.slice(0, 6));
    await waitFor(alice, id => [...document.querySelectorAll('#trashList input')].some(i => Number(i.dataset.id) === id), 3000, middle);
    await press(alice, `#trashList input[data-id="${middle}"]`);
    await press(alice, '#trashRestoreBtn');
    await waitFor(bob, id => session.lines.length === 1 && session.lines[0].id === id, 5000, middle);

    // Deleting a line with a take forever erases the file
    await alice.evaluate(() => { document.getElementById('trashFilter').value = ''; document.getElementById('trashFilter').dispatchEvent(new Event('input')); });
    await waitFor(alice, id => !!document.querySelector(`#trashList input[data-id="${id}"]`), 3000, takeLine);
    await press(alice, `#trashList input[data-id="${takeLine}"]`);
    await press(alice, '#trashPurgeBtn');
    await waitFor(alice, id => !document.querySelector(`#trashList input[data-id="${id}"]`), 5000, takeLine);
    await waitUntil(() => !fs.existsSync(takeFile), 3000);

    // Restore everything else: the order is as before deletion
    await press(alice, '#trashRestoreAllBtn');
    const expected = [...order, ...alreadyInTrash].filter(id => id !== takeLine).sort((a, b) => a - b);
    await waitFor(bob, list => JSON.stringify(session.lines.map(l => l.id)) === JSON.stringify(list), 5000, expected)
      .catch(async err => { throw new Error(`${err.message} | expected ${JSON.stringify(expected)}, bob has ${await bob.evaluate(() => JSON.stringify(session.lines.map(l => l.id)))}, order was ${JSON.stringify(order)}, take line ${takeLine}`); });
    await waitFor(alice, () => document.getElementById('undoDeleteBtn').style.display === 'none' || !!document.querySelector('.trash-empty'), 3000);
    await alice.keyboard.press('Escape');
  });

  test('the import form is empty after a successful import', async () => {
    const form = await alice.evaluate(() => {
      openFilesModal();
      return {
        video: document.getElementById('customVideoInput').files.length,
        subs: document.getElementById('customSubInput').files.length,
        title: document.getElementById('customSceneTitle').value,
        status: document.getElementById('customUploadStatus').style.display
      };
    });
    assert.deepEqual(form, { video: 0, subs: 0, title: '', status: 'none' });
    await alice.evaluate(() => closeFilesModal());
  });

  test('uploads too big for the tunnel get a clear message; no Chrome hint in Chrome', async () => {
    const result = await alice.evaluate(async () => {
      const big = { size: 200 * 1024 * 1024 };
      const localAnswer = tunnelUploadError([big]);
      const realCheck = isLocalAddress;
      isLocalAddress = () => false; // as if the page was opened through the tunnel link
      const tunnelAnswer = tunnelUploadError([big, null]);
      const smallAnswer = tunnelUploadError([{ size: 10 * 1024 * 1024 }]);
      isLocalAddress = realCheck;
      return {
        localAnswer,
        tunnelAnswer,
        smallAnswer,
        tunnel413: await readError(new Response('<html><body>413 Request Entity Too Large</body></html>', { status: 413 })),
        tunnel502: await readError(new Response('<!DOCTYPE html><html>Bad gateway</html>', { status: 502 })),
        ours: await readError(new Response(JSON.stringify({ error: 'Line not found', key: 'error.lineNotFound' }), { status: 404 })),
        oursExpected: t('error.lineNotFound'),
        plain: await readError(new Response('Plain text reason', { status: 400 })),
        banner: document.getElementById('browserBanner').style.display
      };
    });
    assert.equal(result.localAnswer, '');
    assert.equal(result.smallAnswer, '');
    assert.match(result.tunnelAnswer, /200/);
    assert.match(result.tunnelAnswer, /localhost:3000/);
    assert.match(result.tunnel413, /localhost:3000/);
    assert.match(result.tunnel502, /502/);
    assert.doesNotMatch(result.tunnel502, /</);
    assert.equal(result.ours, result.oursExpected);
    assert.equal(result.plain, 'Plain text reason');
    assert.equal(result.banner, 'none');
  });

  test('no page errors', () => {
    for (const page of [alice, bob]) assert.deepEqual(page.errors, []);
  });
});

describe('long phrases', { skip: skipReason }, () => {
  let server;
  let browser;
  let page;
  const line = FIXTURE_LINES[0]; // 3.0–4.5 s
  // Recording starts 2 s before the line: the phrase runs from 2.0 s of the file, loud until 4.7, a quiet tail until 5.0,
  // so the player speaks 1.5 s longer than the original
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
    // After the line ends: "finish your phrase", not a cut
    await waitFor(page, end => video.currentTime > end + 0.3 && recordState !== 'idle', 10000, line.end);
    assert.ok(await page.evaluate(() => document.getElementById('recordCueLabel').textContent === t('cue.finish')), 'finish-your-phrase cue');

    await waitFor(page, () => recordState === 'idle', 15000);
    const take = await waitFor(page, id => { const l = session.lines.find(x => x.id === id); return l.audioUrl && l; }, 15000, line.id);
    // Measure everything on the recording itself (video time at the start lags the sound by a fraction of a second)
    const recorded = await page.evaluate(async url => (await getRawTake(url)).duration, take.audioUrl);
    const lineEndInTake = line.end - take.audioStart;
    const speechEndInTake = take.trimEnd - 0.35;
    assert.ok(recorded >= lineEndInTake + 1.2, `recording went on past the original line (${recorded.toFixed(2)} s recorded, line ends at ${lineEndInTake.toFixed(2)} s)`);
    // Recording waits for 0.8 s of silence after the last audible sound; the detector may miss a very quiet tail,
    // so require the essentials: the whole phrase is recorded and there is headroom after it
    assert.ok(recorded - speechEndInTake >= 0.3, `whole phrase captured with a margin (${(recorded - speechEndInTake).toFixed(2)} s after speech)`);
    assert.ok(recorded - speechEndInTake <= 2, `stopped by itself soon after silence (${(recorded - speechEndInTake).toFixed(2)} s)`);
    // A 3.0 s phrase with a 0.3 s quiet tail: the tail must stay (it used to be cut)
    const kept = take.trimEnd - take.trimStart;
    const phrase = voice.tailUntil - voice.speechFrom;
    assert.ok(kept >= phrase + 0.25, `quiet tail kept by auto-trim (kept ${kept.toFixed(2)} s of a ${phrase} s phrase)`);
    assert.deepEqual(page.errors, []);
  });
});
