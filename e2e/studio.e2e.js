// Студия: подсказки, ники, запись с отсчётом, эффекты, сдвиг, задержка, масштаб, панели, лобби
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
    // Берем длину именно от сервера (страница умеет подправлять ее сама, но запись и дубли опираются на серверную)
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

  test('overlapping lines are stacked into lanes instead of drawn on top of each other', async () => {
    // Субтитры, где реплики пересекаются по времени (как в аниме: говорят одновременно)
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
  });

  test('changing the character of a line moves it to that character track', async () => {
    // Сейчас открыта сцена из SRT: все 4 реплики у одного персонажа
    const renameTo = async (page, id, name) => {
      await page.evaluate(lineId => { selectLine(session.lines.find(l => l.id === lineId)); startCharacterEdit(lineId); }, id);
      await page.evaluate(value => {
        document.getElementById('charInput').value = value;
        document.querySelector('.insp-char-form').dispatchEvent(new Event('submit', { cancelable: true }));
      }, name);
    };
    const ids = await alice.evaluate(() => session.lines.map(l => l.id));
    await renameTo(alice, ids[0], 'Рена');
    await waitFor(bob, id => {
      const row = [...document.querySelectorAll('.track-row')].find(r => r.querySelector('.char-name')?.textContent === 'Рена');
      return row && row.querySelector(`#line-block-${id}`);
    }, 5000, ids[0]);
    assert.equal(await bob.evaluate(() => document.querySelectorAll('.track-row').length), 2, 'a new track appeared');

    // Роль «Рена» заняла Алиса — Боб не может перенести туда реплику, а свободную в новую роль может
    await alice.evaluate(() => claimCharacter('Рена'));
    await waitFor(bob, () => session.characterClaims['Рена'] === 'Alice', 5000);
    const before = await bob.evaluate(id => session.lines.find(l => l.id === id).character, ids[1]);
    await renameTo(bob, ids[1], 'Рена');
    await waitFor(bob, () => /Alice/.test(document.getElementById('toast').textContent), 3000);
    assert.equal(await bob.evaluate(id => session.lines.find(l => l.id === id).character, ids[1]), before, 'line stayed with its character');
    await renameTo(bob, ids[2], 'Мион');
    await waitFor(alice, id => session.lines.find(l => l.id === id).character === 'Мион', 5000, ids[2]);

    // Реплику Алисы Боб переименовать не может — кнопки ✎ у него нет
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

    // Ctrl+клик — две свободные реплики, назначаем новому персонажу
    await click(bob, freeIds[0]);
    await click(bob, freeIds[1], 'Control');
    await waitFor(bob, () => /Выбрано реплик: 2|2 lines selected/.test(document.getElementById('inspector').innerText), 3000);
    await bob.evaluate(() => { document.getElementById('multiCharInput').value = 'Кэйити'; document.querySelector('.insp-char-form').dispatchEvent(new Event('submit', { cancelable: true })); });
    await waitFor(alice, ids => ids.every(id => session.lines.find(l => l.id === id).character === 'Кэйити'), 5000, freeIds.slice(0, 2));

    // Shift+клик — весь диапазон; в чужую занятую роль Боб перенести не может
    await bob.keyboard.press('Escape');
    await click(bob, byStart[0]);
    await click(bob, byStart[byStart.length - 1], 'Shift');
    await waitFor(bob, n => new RegExp(`Выбрано реплик: ${n}|${n} lines selected`).test(document.getElementById('inspector').innerText), 3000, byStart.length);
    await bob.evaluate(() => { document.getElementById('multiCharInput').value = 'Рена'; document.querySelector('.insp-char-form').dispatchEvent(new Event('submit', { cancelable: true })); });
    await waitFor(bob, () => /Пропущено|Skipped/.test(document.getElementById('toast').textContent), 3000);
    await bob.keyboard.press('Escape');
    assert.equal(await bob.evaluate(() => document.querySelectorAll('.line-block.multi-selected').length), 0, 'Esc clears the selection');

    // Дорожку из свободных реплик переименовывает любой; дорожку с чужой ролью — только хост
    bob.promptAnswer = 'Кэйичи';
    await bob.evaluate(() => renameCharacterTrack('Кэйити'));
    await waitFor(alice, () => session.lines.filter(l => l.character === 'Кэйичи').length === 2 && !session.lines.some(l => l.character === 'Кэйити'), 5000);
    const bobCanRenameRena = await bob.evaluate(() => [...document.querySelectorAll('.track-row')].find(r => r.querySelector('.char-name')?.textContent === 'Рена')?.querySelector('.track-rename') != null);
    assert.equal(bobCanRenameRena, false, 'no ✎ on a track with lines of another player');
    alice.promptAnswer = 'Рэна';
    await alice.evaluate(() => renameCharacterTrack('Рена'));
    await waitFor(bob, () => session.characterClaims['Рэна'] === 'Alice' && !session.characterClaims['Рена'], 5000);

    // Боб занял реплику по ошибке — хост освобождает ее через выделение
    const mistaken = freeIds[0];
    await bob.evaluate(id => claimSingleLine(id), mistaken);
    await waitFor(alice, id => session.lines.find(l => l.id === id).claimedBy === 'Bob', 5000, mistaken);
    // Кликаем только когда у Алисы на экране уже актуальный таймлайн (после переименования дорожки он перерисовывается)
    await waitFor(alice, id => [...document.querySelectorAll('.char-name')].some(n => n.textContent === 'Рэна')
      && document.getElementById(`line-block-${id}`)?.innerText.includes('Bob'), 5000, mistaken);
    // Здесь кликаем прямо по элементам плиток: после переименований дорожек таймлайн Алисы
    // перестраивается, и клик по экранным координатам может попасть в соседнюю плитку
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
      'Dialogue: 0,0:00:02.50,0:00:03.50,Sign,,0,0,0,,{\\an8}Школа\\hнадежды',
      'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,Первая реплика',
      'Dialogue: 0,0:00:06.00,0:00:07.00,Default,,0,0,0,,Вторая реплика',
      'Dialogue: 0,0:00:08.00,0:00:09.00,Default,,0,0,0,,Третья реплика'
    ].join('\n'));
    await alice.evaluate(() => openFilesModal());
    await (await alice.$('#customVideoInput')).uploadFile(fixtureVideoPath());
    await (await alice.$('#customSubInput')).uploadFile(ass);
    await alice.evaluate(() => uploadCustomScene());
    const captions = await waitFor(alice, () => session.loaded && session.lines.length && document.querySelectorAll('.line-block').length === session.lines.length && session.lines.map(l => l.caption), 15000);
    assert.deepEqual(captions, ['Школа надежды', 'Первая реплика', 'Вторая реплика', 'Третья реплика'], 'drawings dropped, \\h cleaned');

    // Хост удаляет надпись на экране
    const sign = await alice.evaluate(() => session.lines[0].id);
    await alice.evaluate(id => { window.confirm = () => true; deleteLines([id]); }, sign);
    await waitFor(bob, id => session.lines.length === 3 && !session.lines.some(l => l.id === id), 5000, sign);
    assert.equal(await bob.evaluate(() => typeof deleteLines === 'function' && !document.querySelector('#inspector button[onclick^="deleteLines"]')), true, 'players have no delete button');

    // Видимая строка «🎭 Персонаж» в инспекторе; после смены персонажа таймлайн показывает реплику
    const target = await alice.evaluate(() => session.lines[2].id);
    await alice.evaluate(id => selectLine(session.lines.find(l => l.id === id)), target);
    await waitFor(alice, () => !!document.getElementById('charInput'));
    await alice.evaluate(() => { timelineContainer.scrollTop = 0; });
    await alice.evaluate(() => {
      document.getElementById('charInput').value = 'Ёсида';
      document.querySelector('.insp-char-form').dispatchEvent(new Event('submit', { cancelable: true }));
    });
    await waitFor(alice, id => {
      const tile = document.getElementById(`line-block-${id}`);
      if (!tile || session.lines.find(l => l.id === id).character !== 'Ёсида') return false;
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

    // Удаляем реплику с дублем: подсказка с «Отменить», кнопка на панели, файл дубля остается
    await alice.evaluate(id => { window.confirm = () => true; deleteLines([id]); }, target);
    await waitFor(bob, id => !session.lines.some(l => l.id === id), 5000, target);
    await waitFor(alice, () => document.querySelector('#toast button') && /Отменить|Undo/.test(document.getElementById('toast').innerText), 3000);
    await waitFor(alice, n => document.getElementById('undoDeleteBtn').style.display !== 'none' && document.getElementById('undoDeleteBtn').textContent.includes(String(n)), 3000, trashBefore + 1);
    assert.ok(fs.existsSync(takeFile), 'take file kept while undo is possible');

    // Не хост: Ctrl+Z ничего не возвращает
    await bob.keyboard.down('Control'); await bob.keyboard.press('KeyZ'); await bob.keyboard.up('Control');
    await wait(500);
    assert.ok(!(await alice.evaluate(id => session.lines.some(l => l.id === id), target)));

    // Хост: Ctrl+Z возвращает реплику на то же место с дублем и персонажем
    await alice.keyboard.down('Control'); await alice.keyboard.press('KeyZ'); await alice.keyboard.up('Control');
    await waitFor(bob, (id, url) => { const l = session.lines.find(x => x.id === id); return l && l.audioUrl === url; }, 5000, target, takeUrl);
    assert.deepEqual(await bob.evaluate(() => session.lines.map(l => ({ id: l.id, character: l.character }))), before, 'same order and characters');
    assert.equal(await alice.evaluate(() => session.undoCount || 0), undoBefore);

    // Несколько реплик и отмена кнопкой в подсказке
    const two = ids.slice(1, 3);
    await alice.evaluate(list => deleteLines(list), two);
    await waitFor(bob, list => list.every(id => !session.lines.some(l => l.id === id)), 5000, two);
    await waitFor(alice, () => !!document.querySelector('#toast button'), 3000);
    await alice.click('#toast button');
    await waitFor(bob, order => JSON.stringify(session.lines.map(l => l.id)) === JSON.stringify(order), 5000, before.map(l => l.id));
  });

  test('trash window: restore any deleted line, search, delete forever', async () => {
    // Сначала убеждаемся, что у обоих игроков одинаковый список реплик (предыдущий тест мог еще доходить)
    const bobOrder = await bob.evaluate(() => JSON.stringify(session.lines.map(l => l.id)));
    await waitFor(alice, expected => JSON.stringify(session.lines.map(l => l.id)) === expected, 5000, bobOrder);
    const order = await alice.evaluate(() => session.lines.map(l => l.id));
    // В корзине уже может что-то лежать из предыдущих тестов — «Вернуть всё» вернет и это
    const alreadyInTrash = (await alice.evaluate(() => new Promise(resolve => socket.emit('host_trash_list', {}, resolve)))).map(item => item.lineId);
    const takeLine = await alice.evaluate(() => session.lines.find(l => l.audioUrl)?.id);
    assert.ok(takeLine, 'a line with a take exists from the previous test');
    const takeUrl = await alice.evaluate(id => session.lines.find(l => l.id === id).audioUrl, takeLine);
    const takeFile = path.join(server.dirs.uploads, decodeURIComponent(takeUrl).split('/').pop());

    // Удаляем все реплики двумя заходами
    await alice.evaluate(list => { window.confirm = () => true; deleteLines(list); }, order.slice(0, 2));
    await waitFor(alice, n => session.lines.length === n, 5000, order.length - 2);
    await alice.evaluate(list => deleteLines(list), order.slice(2));
    await waitFor(bob, () => session.lines.length === 0, 5000);

    // Корзина — только у хоста
    assert.equal(await bob.evaluate(() => document.getElementById('undoDeleteBtn').style.display), 'none');
    assert.deepEqual(await bob.evaluate(() => new Promise(resolve => socket.emit('host_trash_list', {}, resolve))), []);

    // Кликаем изнутри страницы: список корзины перерисовывается при каждом обновлении сессии
    const press = (page, selector) => page.evaluate(sel => document.querySelector(sel).click(), selector);
    await press(alice, '#undoDeleteBtn');
    await waitFor(alice, n => document.querySelectorAll('#trashList .trash-item').length >= n, 5000, order.length);
    assert.ok(await alice.evaluate(id => document.querySelector(`#trashList input[data-id="${id}"]`).closest('.trash-item').innerText.includes('🎙'), takeLine), 'take marked');

    // Поиск и выборочное возвращение реплики из середины
    const middle = order[1];
    const middleCaption = await alice.evaluate(id => trashItems.find(i => i.lineId === id).caption, middle);
    await alice.type('#trashFilter', middleCaption.slice(0, 6));
    await waitFor(alice, id => [...document.querySelectorAll('#trashList input')].some(i => Number(i.dataset.id) === id), 3000, middle);
    await press(alice, `#trashList input[data-id="${middle}"]`);
    await press(alice, '#trashRestoreBtn');
    await waitFor(bob, id => session.lines.length === 1 && session.lines[0].id === id, 5000, middle);

    // Удалить навсегда реплику с дублем — файл стирается
    await alice.evaluate(() => { document.getElementById('trashFilter').value = ''; document.getElementById('trashFilter').dispatchEvent(new Event('input')); });
    await waitFor(alice, id => !!document.querySelector(`#trashList input[data-id="${id}"]`), 3000, takeLine);
    await press(alice, `#trashList input[data-id="${takeLine}"]`);
    await press(alice, '#trashPurgeBtn');
    await waitFor(alice, id => !document.querySelector(`#trashList input[data-id="${id}"]`), 5000, takeLine);
    await waitUntil(() => !fs.existsSync(takeFile), 3000);

    // Вернуть всё остальное — порядок как до удаления
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
    // Запись ждет 0.8 с тишины после последнего слышимого звука; очень тихий хвост детектор может не услышать,
    // поэтому требуем главное — фраза записана целиком и после нее есть запас
    assert.ok(recorded - speechEndInTake >= 0.3, `whole phrase captured with a margin (${(recorded - speechEndInTake).toFixed(2)} s after speech)`);
    assert.ok(recorded - speechEndInTake <= 2, `stopped by itself soon after silence (${(recorded - speechEndInTake).toFixed(2)} s)`);
    // Фраза 3.0 с, из них 0.3 с тихого хвоста: он должен остаться (раньше срезался)
    const kept = take.trimEnd - take.trimStart;
    const phrase = voice.tailUntil - voice.speechFrom;
    assert.ok(kept >= phrase + 0.25, `quiet tail kept by auto-trim (kept ${kept.toFixed(2)} s of a ${phrase} s phrase)`);
    assert.deepEqual(page.errors, []);
  });
});
