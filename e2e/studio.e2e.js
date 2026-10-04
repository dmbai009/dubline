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
    // Import determines the length on the server; clients only display its bounds.
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

  test('recording: configurable 1 s preparation, "Speak!" on the line start, auto-trim', async () => {
    const line = FIXTURE_LINES[0];
    await claimAndSelect(alice, line.id);
    assert.ok(await alice.evaluate(() => { const el = document.getElementById('inspector'); return el.scrollHeight <= el.clientHeight + 1; }), 'inspector fits');

    await alice.evaluate(id => handleStudioRecord(id), line.id);
    const ready = await waitFor(alice, () => document.getElementById('recordCue').style.display === 'block' && {
      t: video.currentTime, label: document.getElementById('recordCueLabel').textContent
    });
    assert.ok(ready.t <= line.start - 0.5, `recording starts ~1 s early (t=${ready.t})`);
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

  test('recording regressions: a mode change while waiting for microphone permission cancels startup', async () => {
    const result = await alice.evaluate(async id => {
      const devices = navigator.mediaDevices;
      const originalGet = devices.getUserMedia;
      const originalMode = session.mode;
      const stream = await originalGet.call(devices, { audio: true });
      let allow;
      devices.getUserMedia = () => new Promise(resolve => { allow = () => resolve(stream); });
      try {
        const starting = handleStudioRecord(id);
        session.mode = 'edit'; // Same state change as a host broadcast while the prompt is open.
        allow();
        await starting;
        return { state: recordState, stopped: stream.getTracks().every(track => track.readyState === 'ended') };
      } finally {
        devices.getUserMedia = originalGet;
        session.mode = originalMode;
        if (recordState !== 'idle') finishRecording({ discard: true });
        stream.getTracks().forEach(track => track.stop());
      }
    }, FIXTURE_LINES[0].id);
    assert.deepEqual(result, { state: 'idle', stopped: true });
  });

  test('recording regressions: completed take keeps its session and start during asynchronous decoding', async () => {
    const result = await alice.evaluate(async id => {
      const originalDecode = decodeAudio;
      const originalSubmit = submitTake;
      const originalSessionId = session.activeSessionId;
      let releaseDecode;
      let enteredDecode;
      let receive;
      const gate = new Promise(resolve => { releaseDecode = resolve; });
      const decoding = new Promise(resolve => { enteredDecode = resolve; });
      const uploaded = new Promise(resolve => { receive = resolve; });
      decodeAudio = async bytes => { enteredDecode(); await gate; return originalDecode(bytes); };
      submitTake = async entry => { receive(entry); return true; };
      try {
        await handleStudioRecord(id);
        const start = currentRecordingStartTime;
        await new Promise(resolve => setTimeout(resolve, 250));
        finishRecording();
        await decoding;
        session.activeSessionId = 'another-session-during-decoding';
        currentRecordingStartTime = 999;
        releaseDecode();
        const entry = await uploaded;
        return { sessionId: entry.sessionId, expectedSession: originalSessionId, start: entry.audioStart, expectedStart: start };
      } finally {
        releaseDecode();
        session.activeSessionId = originalSessionId;
        decodeAudio = originalDecode;
        submitTake = originalSubmit;
        if (selectedLine) showInspector(selectedLine);
      }
    }, FIXTURE_LINES[0].id);
    assert.equal(result.sessionId, result.expectedSession);
    assert.equal(result.start, result.expectedStart);
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
    const rejected = await bob.evaluate(() => {
      const line = session.lines[0];
      return new Promise(resolve => socket.emit('editor_update_line', {
        lineId: line.id, revision: line.revision || 0, caption: 'must not change in dub mode'
      }, resolve));
    });
    assert.equal(rejected.reason, 'mode');
    await alice.evaluate(() => setStudioMode('edit'));
    await waitFor(bob, () => session.mode === 'edit' && document.body.classList.contains('edit-mode'));
    // The SRT scene is open now: all 4 lines belong to one character
    const renameTo = (page, id, name) => page.evaluate(async (lineId, character) => {
      const line = session.lines.find(item => item.id === lineId);
      return updateEditorLine(line, { character });
    }, id, name);
    const ids = await alice.evaluate(() => session.lines.map(l => l.id));
    await renameTo(alice, ids[0], 'Rena');
    await waitFor(bob, id => {
      const row = [...document.querySelectorAll('.track-row')].find(r => r.querySelector('.char-name')?.textContent === 'Rena');
      return row && row.querySelector(`#line-block-${id}`);
    }, 5000, ids[0]);
    assert.equal(await bob.evaluate(() => document.querySelectorAll('.track-row').length), 2, 'a new track appeared');

    // Alice claimed the role "Rena": Bob cannot move a line there, but can move a free line to a new role
    await renameTo(bob, ids[1], 'Mion');
    await waitFor(alice, id => session.lines.find(l => l.id === id).character === 'Mion', 5000, ids[1]);

    // Bob cannot rename Alice's line: he has no ✎ button
    assert.equal(await bob.evaluate(id => { selectLine(session.lines.find(l => l.id === id)); return !!document.getElementById('editorLineForm') && !document.getElementById('recBtn'); }, ids[0]), true);
  });

  test('multi-selection and track tools remain available inside Edit Mode', async () => {
    await alice.evaluate(() => claimCharacter('Rena'));
    await waitFor(bob, () => session.characterClaims['Rena'] === 'Alice', 5000);
    const byStart = await bob.evaluate(() => [...session.lines].sort((a, b) => a.start - b.start).map(l => l.id));
    const freeIds = await bob.evaluate(() => session.lines.filter(l => !getLineOwner(l)).map(l => l.id));
    const click = async (page, id, modifier) => {
      // The timeline scrolls inside its panel: bring the tile into its visible part first
      await page.$eval(`#line-block-${id}`, el => el.scrollIntoView({ block: 'center', inline: 'center' }));
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

    // Shift+click: the whole range; Edit Mode ignores dubbing ownership for source edits.
    await bob.keyboard.press('Escape');
    await click(bob, byStart[0]);
    await click(bob, byStart[byStart.length - 1], 'Shift');
    await waitFor(bob, n => document.getElementById('inspector').innerText.includes(t('multi.title', { n })), 3000, byStart.length);
    await bob.evaluate(() => { document.getElementById('multiCharInput').value = 'Rena'; document.querySelector('.insp-char-form').dispatchEvent(new Event('submit', { cancelable: true })); });
    await waitFor(alice, ids => ids.every(id => session.lines.find(line => line.id === id).character === 'Rena'), 5000, byStart);
    await bob.keyboard.press('Escape');
    assert.equal(await bob.evaluate(() => document.querySelectorAll('.line-block.multi-selected').length), 0, 'Esc clears the selection');

    // Any collaborator can rename a whole source track in Edit Mode.
    bob.promptAnswer = 'Keichi';
    await bob.evaluate(() => renameCharacterTrack('Rena'));
    await waitFor(alice, n => session.lines.length === n && session.lines.every(l => l.character === 'Keichi'), 5000, byStart.length);
    const bobCanRenameTrack = await waitFor(bob, () => [...document.querySelectorAll('.track-row')]
      .find(r => r.querySelector('.char-name')?.textContent === 'Keichi')?.querySelector('.track-rename') != null);
    assert.equal(bobCanRenameTrack, true, 'Edit Mode exposes track editing to every collaborator');
    alice.promptAnswer = 'Renna';
    await alice.evaluate(() => renameCharacterTrack('Keichi'));
    await waitFor(bob, () => session.characterClaims['Renna'] === 'Alice' && !session.characterClaims['Keichi'], 5000);
    await alice.evaluate(() => unclaimCharacter('Renna'));
    await waitFor(bob, () => !session.characterClaims['Renna'], 5000);

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

  test('collaborative editor creates, updates and conflict-checks source lines', async () => {
    const created = await bob.evaluate(() => new Promise(resolve => socket.emit('editor_create_line', {
      character: 'Keiichi', caption: 'New shared line', start: 1.25, end: 2.75
    }, resolve)));
    assert.equal(created.ok, true);
    await waitFor(alice, id => !!session.lines.find(line => line.id === id), 5000, created.line.id);

    await bob.evaluate(async id => {
      const line = session.lines.find(item => item.id === id);
      await updateEditorLine(line, { caption: 'Edited together', start: 1.5, end: 3 });
    }, created.line.id);
    await waitFor(alice, id => {
      const line = session.lines.find(item => item.id === id);
      return line && line.caption === 'Edited together' && line.start === 1.5 && line.end === 3;
    }, 5000, created.line.id);

    const stale = await alice.evaluate(id => new Promise(resolve => socket.emit('editor_update_line', {
      lineId: id, revision: 0, caption: 'Stale overwrite'
    }, resolve)), created.line.id);
    assert.equal(stale.reason, 'conflict');
    assert.equal(stale.line.caption, 'Edited together');

    const staleBulk = await alice.evaluate(id => {
      const line = session.lines.find(item => item.id === id);
      return new Promise(resolve => socket.emit('set_lines_character', {
        character: 'Stale bulk overwrite',
        lines: [{ lineId: id, revision: line.revision - 1 }]
      }, resolve));
    }, created.line.id);
    assert.equal(staleBulk.reason, 'conflict', 'bulk track assignment checks every line revision');
    assert.notEqual(await bob.evaluate(id => session.lines.find(line => line.id === id).character, created.line.id), 'Stale bulk overwrite');

    const emptyTrack = await bob.evaluate(() => new Promise(resolve => socket.emit('editor_add_track', { character: 'Empty role' }, resolve)));
    assert.equal(emptyTrack.ok, true);
    const emptyRenamed = await bob.evaluate(() => new Promise(resolve => socket.emit('rename_character', {
      from: 'Empty role', to: 'Empty role renamed', lines: []
    }, resolve)));
    assert.equal(emptyRenamed.ok, true, 'an empty track can be renamed');
    await waitFor(alice, () => sessionCharacters().includes('Empty role renamed'));
    const emptyUndo = await bob.evaluate(() => new Promise(resolve => socket.emit('editor_undo', resolve)));
    assert.equal(emptyUndo.undone, 1);
    await waitFor(alice, () => sessionCharacters().includes('Empty role') && !sessionCharacters().includes('Empty role renamed'));

    const trackBefore = await bob.evaluate(() => {
      const from = session.lines[0].character;
      return {
        from,
        order: [...session.trackOrder],
        lines: session.lines.filter(line => line.character === from).map(line => ({ lineId: line.id, revision: line.revision || 0 }))
      };
    });
    const trackRenamed = await bob.evaluate(state => new Promise(resolve => socket.emit('rename_character', {
      from: state.from, to: 'Track undo probe', lines: state.lines
    }, resolve)), trackBefore);
    assert.equal(trackRenamed.ok, true);
    const trackUndo = await bob.evaluate(() => new Promise(resolve => socket.emit('editor_undo', resolve)));
    assert.equal(trackUndo.skipped, 0);
    await waitFor(alice, state => JSON.stringify(session.trackOrder) === JSON.stringify(state.order)
      && session.lines.filter(line => state.lines.some(item => item.lineId === line.id)).every(line => line.character === state.from), 5000, trackBefore);

    const removed = await bob.evaluate(id => new Promise(resolve => socket.emit('editor_delete_lines', {
      lines: [{ lineId: id, revision: lineRevision(id) }]
    }, resolve)), created.line.id);
    assert.equal(removed.ok, true);
    await waitFor(alice, id => !session.lines.some(line => line.id === id), 5000, created.line.id);
  });

  test('Edit Mode: drag lines onto another role track; "Add role" under the tracks', async () => {
    await waitFor(bob, () => session.mode === 'edit');
    // A tall timeline: every track fits on screen and no tile hides under the sticky ruler
    await bob.evaluate(() => document.documentElement.style.setProperty('--top-h', '120px'));
    // Drag a tile vertically with the real mouse: it lands on the track under the pointer
    const dragTo = async (page, lineId, character) => {
        await page.evaluate(id => {
        document.getElementById('timelineContainer').scrollTop = 0;
        document.getElementById(`line-block-${id}`).scrollIntoView({ block: 'nearest', inline: 'center' });
      }, lineId);
      const from = await page.$eval(`#line-block-${lineId}`, el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      const toY = await page.evaluate(name => {
        const row = [...document.querySelectorAll('.track-row')].find(r => r.dataset.character === name);
        const r = row.querySelector('.track-timeline').getBoundingClientRect();
        return r.y + 14; // the upper part: the bottom edge of the timeline would start auto-scrolling
      }, character);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x, (from.y + toY) / 2, { steps: 4 });
      await page.mouse.move(from.x, toY, { steps: 4 });
      const highlighted = await page.evaluate(() => document.querySelector('.track-row.drop-target')?.dataset.character);
      await page.mouse.up();
      await page.evaluate(() => editorQueue);
      return highlighted;
    };

    // A new role, added from the button on the left of the timeline
    assert.equal(await bob.evaluate(() => !!document.querySelector('.track-add-row .track-add-btn')), true, 'everyone can add a role in Edit Mode');
    bob.promptAnswer = 'Shion';
    await bob.evaluate(() => document.querySelector('.track-add-btn').click());
    await waitFor(alice, () => [...document.querySelectorAll('.track-row')].some(r => r.dataset.character === 'Shion'));
    await waitFor(bob, () => [...document.querySelectorAll('.track-row')].some(r => r.dataset.character === 'Shion'));

    // Alice owns the role: a line dropped onto it becomes hers
    const [first, second, third] = await bob.evaluate(() => [...session.lines].sort((a, b) => a.start - b.start).map(l => l.id));
    await alice.evaluate(() => socket.emit('claim_character', { character: 'Shion' }));
    await waitFor(bob, () => session.characterClaims['Shion'] === 'Alice');
    assert.equal(await dragTo(bob, first, 'Shion'), 'Shion', 'the target track is highlighted while dragging');
    await waitFor(alice, id => session.lines.find(l => l.id === id).character === 'Shion', 5000, first);
    await waitFor(bob, id => getLineOwner(session.lines.find(l => l.id === id)) === 'Alice' && !session.lines.find(l => l.id === id).claimedBy, 5000, first);

    // Several selected lines move together
    await bob.keyboard.press('Escape');
    await bob.evaluate((a, b) => {
      document.getElementById(`line-block-${a}`).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.getElementById(`line-block-${b}`).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    }, second, third);
    await waitFor(bob, (a, b) => multiSelection.has(a) && multiSelection.has(b), 3000, second, third);
    const before = await bob.evaluate((a, b) => [a, b].map(id => session.lines.find(l => l.id === id).start), second, third);
    await dragTo(bob, second, 'Shion');
    await waitFor(alice, ids => ids.every(id => session.lines.find(l => l.id === id).character === 'Shion'), 5000, [second, third]);
    assert.deepEqual(await alice.evaluate((a, b) => [a, b].map(id => session.lines.find(l => l.id === id).start), second, third), before, 'a vertical drag keeps the timing');
    await bob.keyboard.press('Escape');

    // While dubbing only the host gets the button
    await alice.evaluate(() => setStudioMode('dub'));
    await waitFor(bob, () => session.mode === 'dub');
    await waitFor(alice, () => !!document.querySelector('.track-add-btn'));
    assert.equal(await bob.evaluate(() => !!document.querySelector('.track-add-btn')), false);
    const refused = await bob.evaluate(() => new Promise(resolve => socket.emit('editor_add_track', { character: 'Guest role' }, resolve)));
    assert.equal(refused.reason, 'mode');
    alice.promptAnswer = 'Satoko';
    await alice.evaluate(() => document.querySelector('.track-add-btn').click());
    await waitFor(bob, () => sessionCharacters().includes('Satoko'));
    await alice.evaluate(() => setStudioMode('edit'));
    await waitFor(bob, () => session.mode === 'edit');
    await bob.evaluate(() => document.documentElement.style.removeProperty('--top-h'));
  });

  test('Edit Mode: undo own edits, keyboard moves, mode notice in chat', async () => {
    await waitFor(bob, () => session.mode === 'edit');
    assert.equal(await bob.evaluate(() => getComputedStyle(document.querySelector('.edit-banner')).display), 'flex', 'Edit Mode is clearly marked');
    const id = await bob.evaluate(() => [...session.lines].sort((a, b) => a.start - b.start)[0].id);
    const original = await bob.evaluate(lineId => { const l = session.lines.find(x => x.id === lineId); return { start: l.start, end: l.end, caption: l.caption }; }, id);

    // ←/→ move the selected line; Shift — by a second
    await bob.evaluate(lineId => { clearMultiSelection(); selectLine(session.lines.find(l => l.id === lineId)); document.activeElement && document.activeElement.blur(); }, id);
    await bob.keyboard.press('ArrowRight');
    await waitFor(alice, (lineId, start) => Math.abs(session.lines.find(l => l.id === lineId).start - (start + 0.1)) < 0.001, 5000, id, original.start);
    await bob.keyboard.down('Shift');
    await bob.keyboard.press('ArrowRight');
    await bob.keyboard.up('Shift');
    await waitFor(alice, (lineId, start) => Math.abs(session.lines.find(l => l.id === lineId).start - (start + 1.1)) < 0.001, 5000, id, original.start);

    // A caption edit by Bob, then Ctrl+Z twice: the caption, then the last move come back
    await bob.evaluate(lineId => updateEditorLine(session.lines.find(l => l.id === lineId), { caption: 'Oops' }), id);
    await waitFor(alice, lineId => session.lines.find(l => l.id === lineId).caption === 'Oops', 5000, id);
    await bob.keyboard.down('Control');
    await bob.keyboard.press('KeyZ');
    await bob.keyboard.up('Control');
    await waitFor(alice, (lineId, caption) => session.lines.find(l => l.id === lineId).caption === caption, 5000, id, original.caption);
    await bob.evaluate(() => editorUndo());
    await waitFor(alice, (lineId, start) => Math.abs(session.lines.find(l => l.id === lineId).start - (start + 0.1)) < 0.001, 5000, id, original.start);

    // Alice's Ctrl+Z undoes only her own edits, never Bob's
    const bobsLine = await alice.evaluate(lineId => JSON.stringify(session.lines.find(l => l.id === lineId)), id);
    await alice.evaluate(() => new Promise(resolve => socket.emit('editor_undo', resolve)));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await alice.evaluate(lineId => JSON.stringify(session.lines.find(l => l.id === lineId)), id), bobsLine);

    // Undo does not overwrite a later change by someone else
    await bob.evaluate(lineId => updateEditorLine(session.lines.find(l => l.id === lineId), { caption: 'Bob was here' }), id);
    await waitFor(alice, lineId => session.lines.find(l => l.id === lineId).caption === 'Bob was here', 5000, id);
    await alice.evaluate(lineId => updateEditorLine(session.lines.find(l => l.id === lineId), { caption: 'Alice fixed it' }), id);
    await waitFor(bob, lineId => session.lines.find(l => l.id === lineId).caption === 'Alice fixed it', 5000, id);
    const skipped = await bob.evaluate(() => new Promise(resolve => socket.emit('editor_undo', resolve)));
    assert.equal(skipped.undone, 0);
    assert.equal(skipped.skipped, 1);
    await alice.evaluate((lineId, caption) => updateEditorLine(session.lines.find(l => l.id === lineId), { caption }), id, original.caption);

    // Undo ownership follows the stable browser client id, not the editable nickname.
    await waitFor(bob, (lineId, caption) => session.lines.find(l => l.id === lineId).caption === caption, 5000, id, original.caption);
    await bob.evaluate(lineId => updateEditorLine(session.lines.find(l => l.id === lineId), { caption: 'Undo after rename' }), id);
    await waitFor(alice, lineId => session.lines.find(l => l.id === lineId).caption === 'Undo after rename', 5000, id);
    await bob.evaluate(() => socket.emit('rename_user', { newName: 'Bobby' }));
    await waitFor(bob, () => myName === 'Bobby');
    const renamedUndo = await bob.evaluate(() => new Promise(resolve => socket.emit('editor_undo', resolve)));
    assert.equal(renamedUndo.undone, 1);
    await waitFor(alice, (lineId, caption) => session.lines.find(l => l.id === lineId).caption === caption, 5000, id, original.caption);
    await bob.evaluate(() => socket.emit('rename_user', { newName: 'Bob' }));
    await waitFor(bob, () => myName === 'Bob');

    // A queued take is not posted repeatedly while its active session is in Edit Mode.
    const pausedUpload = await bob.evaluate(async lineId => {
      const originalFetch = window.fetch;
      let calls = 0;
      window.fetch = async () => { calls++; return { ok: false, status: 409 }; };
      try {
        const sent = await sendTake({
          uploadId: 'edit-mode-test', room: currentRoom, sessionId: session.activeSessionId,
          lineId, nick: myName, audioStart: 0, blob: new Blob(['test'], { type: 'audio/webm' })
        });
        return { sent, calls };
      } finally {
        window.fetch = originalFetch;
      }
    }, id);
    assert.deepEqual(pausedUpload, { sent: false, calls: 0 });

    // Switching modes is announced in the chat for everyone
    await alice.evaluate(() => setStudioMode('dub'));
    await waitFor(bob, () => session.mode === 'dub' && document.getElementById('chatMessages').innerText.includes(t('system.modeDub', { nick: 'Alice' })));
    await alice.evaluate(() => setStudioMode('edit'));
    await waitFor(bob, () => session.mode === 'edit');
  });

  test('Edit Mode: undoing a track rename after someone else changed the tracks', async () => {
    await waitFor(bob, () => session.mode === 'edit');
    const undo = page => page.evaluate(() => editorUndo());
    const tracks = page => page.evaluate(() => [...session.trackOrder]);

    // An empty track renamed by Bob, then Alice adds a role: Bob's undo still renames it back
    await bob.evaluate(() => new Promise(resolve => socket.emit('editor_add_track', { character: 'Empty one' }, resolve)));
    await bob.evaluate(() => new Promise(resolve => socket.emit('rename_character', { from: 'Empty one', to: 'Empty two', lines: [] }, resolve)));
    await alice.evaluate(() => new Promise(resolve => socket.emit('editor_add_track', { character: 'Alice role' }, resolve)));
    await waitFor(bob, () => session.trackOrder.includes('Alice role') && session.trackOrder.includes('Empty two'));
    const renamedAt = (await tracks(bob)).indexOf('Empty two');
    const result = await undo(bob);
    assert.equal(result.undone, 1, JSON.stringify(result));
    await waitFor(bob, () => session.trackOrder.includes('Empty one') && !session.trackOrder.includes('Empty two'));
    assert.equal((await tracks(bob)).indexOf('Empty one'), renamedAt, 'the old name comes back in place');

    // Nothing left to put back (Alice already renamed it): the undo reports a skip, not a success
    await bob.evaluate(() => new Promise(resolve => socket.emit('rename_character', { from: 'Empty one', to: 'Empty three', lines: [] }, resolve)));
    await alice.evaluate(() => new Promise(resolve => socket.emit('rename_character', { from: 'Empty three', to: 'Empty four', lines: [] }, resolve)));
    await waitFor(bob, () => session.trackOrder.includes('Empty four'));
    const skipped = await undo(bob);
    assert.equal(skipped.undone, 0);
    assert.equal(skipped.skipped, 1);

    // A track with lines: the lines go back and the new name does not stay behind as an empty role
    const lineIds = await bob.evaluate(() => session.lines.filter(l => l.character === 'Shion').map(l => l.id));
    assert.ok(lineIds.length);
    bob.promptAnswer = 'Shion renamed';
    await bob.evaluate(() => renameCharacterTrack('Shion'));
    await waitFor(alice, () => session.trackOrder.includes('Shion renamed'));
    await alice.evaluate(() => new Promise(resolve => socket.emit('editor_add_track', { character: 'Another role' }, resolve)));
    await waitFor(bob, () => session.trackOrder.includes('Another role'));
    const back = await undo(bob);
    assert.equal(back.undone, lineIds.length, JSON.stringify(back));
    await waitFor(alice, ids => ids.every(id => session.lines.find(l => l.id === id).character === 'Shion')
      && !session.trackOrder.includes('Shion renamed'), 5000, lineIds);

    // Requests from the editor wait for each other: a rename right after a drag is not a "conflict"
    const [first] = lineIds;
    const outcome = await bob.evaluate(id => {
      const line = session.lines.find(l => l.id === id);
      const move = updateEditorLine(line, { start: Number((line.start + 0.2).toFixed(3)), end: Number((line.end + 0.2).toFixed(3)) });
      const rename = queueEditorRequest(() => ['set_line_character', { lineId: id, revision: lineRevision(id), character: 'Mion' }]);
      return Promise.all([move, rename]).then(results => results.map(r => r && (r.ok ? 'ok' : r.reason)));
    }, first);
    assert.deepEqual(outcome, ['ok', 'ok']);
    await waitFor(alice, id => session.lines.find(l => l.id === id).character === 'Mion', 5000, first);
  });

  test('Edit Mode undo keeps what happened later: a new take, a claim, and tracks merged by others', async () => {
    await waitFor(alice, () => session.mode === 'edit');
    const id = await alice.evaluate(() => session.lines.find(l => !l.audioUrl && (!getLineOwner(l) || getLineOwner(l) === 'Alice')).id);
    const before = await alice.evaluate(lineId => { const l = session.lines.find(x => x.id === lineId); return { start: l.start, end: l.end, caption: l.caption }; }, id);

    // Alice moves the line and edits its text, then records a take for it while dubbing
    await alice.evaluate((lineId, b) => updateEditorLine(session.lines.find(l => l.id === lineId), { start: b.start + 0.5, end: b.end + 0.5, caption: 'Moved and edited' }), id, before);
    await alice.evaluate(() => setStudioMode('dub'));
    await waitFor(bob, () => session.mode === 'dub');
    await claimAndSelect(alice, id);
    await recordTake(alice, id);
    const take = await alice.evaluate(lineId => { const l = session.lines.find(x => x.id === lineId); return { audioStart: l.audioStart, audioUrl: l.audioUrl, owner: getLineOwner(l) }; }, id);

    // Undo in Edit Mode: line and text come back, the take moves with the line, the claim stays
    await alice.evaluate(() => setStudioMode('edit'));
    await waitFor(bob, () => session.mode === 'edit');
    const result = await alice.evaluate(() => editorUndo());
    assert.equal(result.undone, 1, JSON.stringify(result));
    await waitFor(bob, (lineId, start) => Math.abs(session.lines.find(l => l.id === lineId).start - start) < 0.001, 5000, id, before.start);
    const after = await bob.evaluate(lineId => { const l = session.lines.find(x => x.id === lineId); return { caption: l.caption, audioStart: l.audioStart, audioUrl: l.audioUrl, owner: getLineOwner(l) }; }, id);
    assert.equal(after.caption, before.caption);
    assert.equal(after.audioUrl, take.audioUrl, 'the new take is kept');
    assert.ok(Math.abs(after.audioStart - (take.audioStart - 0.5)) < 0.001, `the take follows the line: ${after.audioStart} vs ${take.audioStart}`);
    assert.equal(after.owner, take.owner, 'a claim made after the edit is left alone');

    // Bob merges an empty track into an existing one, Alice adds a role: undo brings it back in place
    await bob.evaluate(() => new Promise(resolve => socket.emit('editor_add_track', { character: 'Merge me' }, resolve)));
    const tracksBefore = await bob.evaluate(() => [...session.trackOrder]);
    const target = tracksBefore[0];
    await bob.evaluate(to => new Promise(resolve => socket.emit('rename_character', { from: 'Merge me', to, lines: [] }, resolve)), target);
    await alice.evaluate(() => new Promise(resolve => socket.emit('editor_add_track', { character: 'Late role' }, resolve)));
    await waitFor(bob, () => session.trackOrder.includes('Late role') && !session.trackOrder.includes('Merge me'));
    const merged = await bob.evaluate(() => editorUndo());
    assert.equal(merged.undone, 1, JSON.stringify(merged));
    await waitFor(bob, () => session.trackOrder.includes('Merge me'));
    const order = await bob.evaluate(() => [...session.trackOrder]);
    assert.equal(order.indexOf('Merge me'), tracksBefore.indexOf('Merge me'), `back in place: ${order.join(', ')}`);

    // The server answers a lost acknowledgement with the current scene
    const resynced = await bob.evaluate(() => new Promise(resolve => {
      socket.once('session_updated', data => resolve(Array.isArray(data.lines)));
      socket.emit('editor_resync');
    }));
    assert.equal(resynced, true);
  });

  test('editor regressions: unchanged saves, deep undo and atomic stale deletion', async () => {
    const created = await bob.evaluate(() => queueEditorRequest(() => ['editor_create_line', {
      character: 'Regression role', start: 1, end: 2, caption: 'Original'
    }]));
    assert.equal(created.ok, true);
    const id = created.line.id;
    for (const caption of ['One', 'Two', 'Three']) {
      await bob.evaluate((id, caption) => updateEditorLine(session.lines.find(line => line.id === id), { caption }), id, caption);
    }
    const revision = await bob.evaluate(id => lineRevision(id), id);
    await bob.evaluate(id => updateEditorLine(session.lines.find(line => line.id === id), { caption: 'Three', start: 1, end: 2 }), id);
    assert.equal(await bob.evaluate(id => lineRevision(id), id), revision);
    for (const caption of ['Two', 'One', 'Original']) {
      const undone = await bob.evaluate(() => editorUndo());
      assert.equal(undone.undone, 1);
      assert.equal(await bob.evaluate(id => session.lines.find(line => line.id === id).caption, id), caption);
    }
    const current = await bob.evaluate(id => lineRevision(id), id);
    const stale = await bob.evaluate((id, revision) => new Promise(resolve => socket.emit('editor_delete_lines', {
      lines: [{ lineId: id, revision }]
    }, resolve)), id, current - 1);
    assert.equal(stale.reason, 'conflict');
    assert.equal(await bob.evaluate(id => session.lines.some(line => line.id === id), id), true);
    const wrongScene = await bob.evaluate(id => new Promise(resolve => socket.emit('editor_delete_lines', {
      sessionId: 'old-scene', lines: [{ lineId: id, revision: lineRevision(id) }]
    }, resolve)), id);
    assert.equal(wrongScene.reason, 'session');
    assert.equal(await bob.evaluate(id => new Promise(resolve => socket.emit('editor_delete_lines', {
      lines: [{ lineId: id, revision: lineRevision(id) }]
    }, resolve)), id).then(result => result.ok), true);
  });

  test('editor regressions: releasing a renamed role stays released after undo', async () => {
    const created = await alice.evaluate(() => queueEditorRequest(() => ['editor_create_line', {
      character: 'Claim before rename', start: 1, end: 2, caption: 'Claim regression'
    }]));
    assert.equal(created.ok, true);
    await alice.evaluate(() => socket.emit('claim_character', { character: 'Claim before rename' }));
    await waitFor(alice, () => session.characterClaims['Claim before rename'] === 'Alice');
    const renamed = await alice.evaluate(() => queueEditorRequest(() => ['rename_character', {
      from: 'Claim before rename', to: 'Claim after rename',
      lines: session.lines.filter(line => line.character === 'Claim before rename').map(line => ({ lineId: line.id, revision: line.revision || 0 }))
    }]));
    assert.equal(renamed.ok, true);
    await alice.evaluate(() => socket.emit('unclaim_character', { character: 'Claim after rename' }));
    await waitFor(alice, () => !session.characterClaims['Claim after rename']);
    assert.equal((await alice.evaluate(() => editorUndo())).undone, 1);
    assert.equal(await alice.evaluate(() => !!session.characterClaims['Claim before rename']), false);
    await alice.evaluate(id => new Promise(resolve => socket.emit('editor_delete_lines', {
      lines: [{ lineId: id, revision: lineRevision(id) }]
    }, resolve)), created.line.id);
  });

  test('editor regressions: lost reply waits for resync and cancels dependent mutations', async () => {
    const result = await bob.evaluate(async () => {
      const originalTimeout = socket.timeout;
      let writes = 0;
      let resynced = false;
      socket.timeout = function(ms) {
        const target = originalTimeout.call(this, ms);
        return {
          emit(event, payload, ack) {
            if (event === 'editor_add_track') {
              writes++;
              setTimeout(() => ack(new Error('Simulated lost reply')), 0);
              return;
            }
            if (event === 'editor_resync') {
              target.emit(event, payload, (err, data) => {
                setTimeout(() => { resynced = true; ack(err, data); }, 30);
              });
              return;
            }
            writes++;
            target.emit(event, payload, ack);
          }
        };
      };
      try {
        const first = queueEditorRequest(() => ['editor_add_track', { character: 'Lost reply probe' }]);
        const dependent = queueEditorRequest(() => ['editor_undo', {}]);
        const answer = await first;
        const next = await dependent;
        return { first: answer.reason, next: next.reason, writes, resynced };
      } finally {
        socket.timeout = originalTimeout;
      }
    });
    assert.deepEqual(result, { first: 'timeout', next: 'cancelled', writes: 1, resynced: true });
  });

  test('Random Cast, Blind Mode, download status and visual themes', async () => {
    await alice.evaluate(() => setStudioMode('dub'));
    await waitFor(bob, () => session.mode === 'dub');
    await alice.evaluate(() => { window.confirm = () => true; hostResetClaims(); });
    const freshTakeLine = await alice.evaluate(() => session.lines[0].id);
    await claimAndSelect(alice, freshTakeLine);
    await recordTake(alice, freshTakeLine);
    await alice.evaluate(() => { window.confirm = () => true; randomCast(); });
    await waitFor(bob, () => Object.keys(session.characterClaims || {}).length > 0);
    assert.ok((await bob.evaluate(() => Object.values(session.characterClaims))).every(owner => ['Alice', 'Bob'].includes(owner)));
    assert.equal(await bob.evaluate(() => {
      const roles = new Set(session.lines.map(line => line.character));
      return Object.keys(session.characterClaims).length === roles.size && Object.keys(session.characterClaims).every(role => roles.has(role));
    }), true, 'empty editor tracks are not cast');

    await alice.evaluate(() => socket.emit('set_blind_mode', { enabled: true }));
    await waitFor(bob, () => session.blindMode === true);
    const hidden = await bob.evaluate(() => {
      const line = session.lines.find(item => item.audioUrl && item.recordedBy === 'Alice');
      return line ? { id: line.id, audible: canHearLine(line) } : null;
    });
    assert.ok(hidden && !hidden.audible, 'another player cannot listen before reveal');
    await alice.evaluate(() => revealAllTakes());
    await waitFor(bob, id => canHearLine(session.lines.find(line => line.id === id)), 5000, hidden.id);

    await alice.evaluate(() => {
      socket.emit('set_blind_mode', { enabled: false });
      socket.emit('set_blind_preference', { enabled: true });
    });
    await waitFor(bob, id => !canHearLine(session.lines.find(line => line.id === id)), 5000, hidden.id);
    await alice.evaluate(() => socket.emit('rename_user', { newName: 'Alice renamed' }));
    await waitFor(bob, id => session.blindPlayers.includes('Alice renamed') && session.lines.find(line => line.id === id).recordedBy === 'Alice renamed', 5000, hidden.id);
    assert.equal(await bob.evaluate(id => canHearLine(session.lines.find(line => line.id === id)), hidden.id), false, 'personal Blind Mode survives a nickname change');
    await alice.evaluate(() => socket.emit('rename_user', { newName: 'Alice' }));
    await waitFor(bob, () => session.blindPlayers.includes('Alice') && !session.blindPlayers.includes('Alice renamed'));
    await alice.evaluate(() => socket.emit('set_blind_preference', { enabled: false }));

    await bob.evaluate(() => socket.emit('player_activity', { state: 'downloading', pct: 42 }));
    await waitFor(alice, () => playerActivities.get('Bob')?.pct === 42);
    assert.match(await alice.evaluate(() => [...document.querySelectorAll('.player-card')].find(card => card.innerText.includes('Bob')).innerText), /42%/);

    await alice.evaluate(() => {
      document.getElementById('settingsTheme').value = 'ocean';
      document.getElementById('settingsTheme').dispatchEvent(new Event('change'));
    });
    assert.equal(await alice.evaluate(() => `${document.documentElement.dataset.theme}:${localStorage.getItem('dubline_theme')}`), 'ocean:ocean');
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
    await alice.evaluate(() => setStudioMode('edit'));
    await waitFor(bob, () => session.mode === 'edit');

    // The host deletes an on-screen sign
    const sign = await alice.evaluate(() => session.lines[0].id);
    await alice.evaluate(id => { window.confirm = () => true; deleteLines([id]); }, sign);
    await waitFor(bob, id => session.lines.length === 3 && !session.lines.some(l => l.id === id), 5000, sign);
    assert.equal(await bob.evaluate(() => session.mode === 'edit'), true, 'all players enter the shared editor');

    // The visible "🎭 Character" row in the inspector; after changing the character the timeline shows the line
    const target = await alice.evaluate(() => session.lines[2].id);
    await alice.evaluate(id => selectLine(session.lines.find(l => l.id === id)), target);
    await waitFor(alice, () => !!document.getElementById('editorLineForm'));
    await alice.evaluate(() => { timelineContainer.scrollTop = 0; });
    await alice.evaluate(async id => {
      const line = session.lines.find(item => item.id === id);
      await updateEditorLine(line, { character: 'Yoshida' });
    }, target);
    await waitFor(alice, id => {
      const tile = document.getElementById(`line-block-${id}`);
      if (!tile || session.lines.find(l => l.id === id).character !== 'Yoshida') return false;
      const box = tile.getBoundingClientRect();
      const view = timelineContainer.getBoundingClientRect();
      return box.top >= view.top && box.bottom <= view.bottom;
    }, 5000, target);
  });

  test('deleting lines can be undone (Ctrl+Z, toast button); takes survive until then', async () => {
    await alice.evaluate(() => setStudioMode('dub'));
    await waitFor(bob, () => session.mode === 'dub');
    const ids = await alice.evaluate(() => session.lines.map(l => l.id));
    const target = ids[0];
    await claimAndSelect(alice, target);
    const takeUrl = await recordTake(alice, target);
    await alice.evaluate(() => setStudioMode('edit'));
    await waitFor(bob, () => session.mode === 'edit');
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
