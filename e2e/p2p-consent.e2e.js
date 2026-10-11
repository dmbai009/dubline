const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, waitFor } = require('./helpers');

describe('P2P informed consent', { skip: skipReason }, () => {
  let server, browser, host, serial = 0;
  const room = 'p2p-consent';
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); host = await openPlayer(browser, server.url(room), 'Host'); await loadFixture(host); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  async function player(options = {}) {
    return openPlayer(browser, server.url(room, 'dubline.test'), `Guest${++serial}`, { p2pConsent: null, ...options,
      beforeLoad: async page => {
        await page.evaluateOnNewDocument(() => {
          window.videoPeerCount = 0; window.p2pTestMessages = [];
          const nativePC = window.RTCPeerConnection;
          window.RTCPeerConnection = new Proxy(nativePC, { construct(target, args) { videoPeerCount++; return new target(...args); } });
          document.addEventListener('DOMContentLoaded', () => {
            const emit = socket.emit;
            socket.emit = function(event, ...args) { if (['p2p_have', 'p2p_find', 'p2p_signal'].includes(event)) p2pTestMessages.push({ event, files: args[0]?.files?.length || 0 }); return emit.call(this, event, ...args); };
          });
        });
        await options.beforeLoad?.(page);
      }
    });
  }
  const state = page => page.evaluate(() => ({ consent: p2pConsent, enabled: p2pEnabled, checked: settingsP2P.checked, open: p2pConsentDialog.open,
    peers: peers.size, created: videoPeerCount, unsafe: p2pTestMessages.some(item => item.files || item.event !== 'p2p_have') }));
  async function settings(page) {
    await page.click('[onclick="openSettingsModal()"]'); await page.click('#settings-user-storage-tab');
  }
  test('new and legacy users stay disabled; incoming offers are ignored while consent is open; HTTP video works', async () => {
    for (const oldValue of [null, '1', '0', 'corrupt']) {
      const page = await player({ beforeLoad: page => page.evaluateOnNewDocument(value => {
        if (value !== null) localStorage.setItem('dubline_p2p', value);
      }, oldValue) });
      try {
        await waitFor(page, () => p2pConsentDialog.open && localMedia?.videoBlob && video.readyState >= 2, 20000);
        await page.evaluate(async () => {
          await socket.listeners('p2p_signal')[0]({ from: 'probe', sessionId: session.activeSessionId, data: { kind: 'offer', sdp: { type: 'offer', sdp: 'probe' } } });
          await announceHave(true);
        });
        assert.deepEqual(await state(page), { consent: 'undecided', enabled: false, checked: false, open: true, peers: 0, created: 0, unsafe: false });
        assert.equal(await page.evaluate(() => p2pStatus.p2p), 0);
        assert.ok(await page.evaluate(() => p2pStatus.http > 0));
        await page.click('#p2pConsentDecline');
        assert.equal(await page.evaluate(() => localStorage.getItem(P2P_CONSENT_KEY)), 'declined');
        await page.reload(); await waitFor(page, () => p2pJoined && localMedia?.videoBlob);
        assert.equal((await state(page)).open, false); assert.equal((await state(page)).enabled, false);
        assert.deepEqual(page.errors, []);
      } finally { await page.browserContext().close(); }
    }
  });
  test('accept persists; ordinary toggles need no second prompt and reload keeps the off preference', async () => {
    const page = await player();
    try {
      await waitFor(page, () => p2pConsentDialog.open);
      await page.click('#p2pConsentAccept'); await waitFor(page, () => p2pAllowed() && !p2pConsentDialog.open);
      assert.equal(await page.evaluate(() => localStorage.getItem(P2P_CONSENT_KEY)), 'accepted');
      await page.reload(); await waitFor(page, () => p2pJoined && p2pEnabled);
      assert.equal((await state(page)).open, false);
      await settings(page); await page.click('.switch-ui:has(#settingsP2P)');
      assert.equal((await state(page)).enabled, false); assert.equal((await state(page)).open, false);
      await page.reload(); await waitFor(page, () => p2pJoined);
      assert.equal((await state(page)).consent, 'accepted'); assert.equal((await state(page)).checked, false);
      await settings(page); await page.click('.switch-ui:has(#settingsP2P)');
      assert.equal((await state(page)).enabled, true); assert.equal((await state(page)).open, false);
    } finally { await page.browserContext().close(); }
  });
  test('declining, Escape, close icon and ordinary dialog close all require fresh confirmation to opt in', async () => {
    const page = await player();
    try {
      await waitFor(page, () => p2pConsentDialog.open); await page.keyboard.press('Escape');
      await waitFor(page, () => p2pConsent === 'declined' && !p2pConsentDialog.open);
      await settings(page); await page.click('.switch-ui:has(#settingsP2P)');
      assert.equal((await state(page)).checked, false); assert.equal((await state(page)).open, true);
      await page.click('#p2pConsentClose'); await waitFor(page, () => !p2pConsentDialog.open);
      await page.click('.switch-ui:has(#settingsP2P)'); await page.evaluate(() => p2pConsentDialog.close());
      await waitFor(page, () => !p2pConsentDialog.open && p2pConsent === 'declined');
      await page.click('.switch-ui:has(#settingsP2P)'); await page.click('#p2pConsentAccept');
      assert.equal((await state(page)).checked, true); assert.equal((await state(page)).consent, 'accepted');
    } finally { await page.browserContext().close(); }
  });
  test('reload while undecided and reconnect never manufacture consent', async () => {
    const page = await player();
    try {
      await waitFor(page, () => p2pConsentDialog.open); await page.reload(); await waitFor(page, () => p2pConsentDialog.open);
      assert.equal(await page.evaluate(() => localStorage.getItem(P2P_CONSENT_KEY)), null);
      await page.evaluate(() => socket.disconnect()); await waitFor(page, () => !p2pConsentDialog.open);
      await page.evaluate(() => socket.connect()); await waitFor(page, () => p2pConsentDialog.open);
      assert.equal((await state(page)).unsafe, false); assert.equal((await state(page)).created, 0);
    } finally { await page.browserContext().close(); }
  });
  test('first-visit help and nickname entry finish before the consent dialog opens', async () => {
    const page = await player({ helpSeen: false, beforeLoad: page => page.evaluateOnNewDocument(() => localStorage.removeItem('dubline_nick')) });
    try {
      await waitFor(page, () => nickModal.style.display === 'flex'); assert.equal((await state(page)).open, false);
      await page.type('#modalNickInput', `New${serial}`); await page.click('#nickForm button[type=submit]');
      await waitFor(page, () => helpModal.style.display === 'flex'); assert.equal((await state(page)).open, false);
      await page.click('#helpModal [data-i18n="help.ok"]'); await waitFor(page, () => p2pConsentDialog.open);
      assert.equal((await state(page)).unsafe, false);
    } finally { await page.browserContext().close(); }
  });
  test('all themes and languages retain a readable bounded dialog and safe initial keyboard focus', async () => {
    const page = await player({ viewport: { width: 1024, height: 768 } });
    try {
      await waitFor(page, () => p2pConsentDialog.open);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'p2pConsentDecline');
      for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) for (const language of ['en', 'ru', 'uk']) {
        await page.evaluate(async (theme, language) => { document.documentElement.dataset.theme = theme; await i18n.setLanguage(language); }, theme, language);
        const result = await page.evaluate(() => { const r = p2pConsentDialog.getBoundingClientRect(), css = getComputedStyle(p2pConsentDialog);
          const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(value => { const s = Number(value) / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
          const contrast = id => { const a = luminance(getComputedStyle(document.getElementById(id)).color), b = luminance(css.backgroundColor); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
          return { inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
            title: document.getElementById('p2pConsentTitle').textContent, expected: t('p2p.consent.title'), contrast: Math.min(contrast('p2pConsentTitle'), contrast('p2pConsentPrivacy')), missing: i18n.missing.size }; });
        assert.equal(result.inside, true); assert.equal(result.title, result.expected); assert.ok(result.contrast >= 4.5, `${theme}/${language}: contrast ${result.contrast}`); assert.equal(result.missing, 0);
      }
    } finally { await page.browserContext().close(); }
  });
  test('failed consent storage stays disabled and visibly explains why', async () => {
    const page = await player({ beforeLoad: page => page.evaluateOnNewDocument(() => {
      const write = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key.startsWith('dubline_p2p')) throw new DOMException('Storage unavailable', 'QuotaExceededError'); return write.call(this, key, value); };
    }) });
    try {
      await waitFor(page, () => p2pConsentDialog.open); await page.click('#p2pConsentAccept');
      assert.equal((await state(page)).enabled, false); assert.equal((await state(page)).open, true);
      assert.equal(await page.$eval('#p2pConsentError', node => !node.hidden && !!node.textContent), true);
      await page.click('#p2pConsentDecline'); assert.equal((await state(page)).open, false);
      assert.equal((await state(page)).unsafe, false); assert.equal((await state(page)).created, 0);
    } finally { await page.browserContext().close(); }
  });
  test('Single Player neither prompts nor creates P2P connections, including a stored acceptance', async () => {
    const solo = await startServer({ DUBLINE_DESKTOP_ROOM: 'main', DUBLINE_DESKTOP_HOST_TOKEN: 'consent-solo', DUBLINE_ROOM_PIN: 'ABCD', DUBLINE_SINGLE_PLAYER: '1' });
    const page = await openPlayer(browser, solo.url('main') + '&desktopHost=consent-solo&workspace=single', 'Solo', { p2pConsent: 'accepted' });
    try {
      await waitFor(page, () => session?.singlePlayer && p2pJoined); await loadFixture(page);
      assert.equal(await page.evaluate(() => p2pConsentDialog.open || p2pAllowed() || settingsP2P.checked || peers.size > 0), false);
    } finally { await page.browserContext().close(); await solo.cleanup(); }
  });
  test('disabling a real active upload closes peers and its receiver completes through HTTP', async () => {
    const seed = await player(); let receiver;
    try {
      await waitFor(seed, () => p2pConsentDialog.open && localMedia?.videoBlob);
      await seed.click('#p2pConsentAccept');
      await seed.evaluate(async () => { await announceHave(true); window.mediaUploadLimiter = { take: () => new Promise(resolve => { window.releaseConsentUpload = resolve; }) }; });
      await waitFor(host, nick => seedingNicks.has(nick), 5000, await seed.evaluate(() => myName));
      receiver = await player({ p2pConsent: 'accepted' });
      await waitFor(seed, () => typeof releaseConsentUpload === 'function' && peers.size > 0, 15000);
      await settings(seed); await seed.click('.switch-ui:has(#settingsP2P)');
      assert.equal(await seed.evaluate(() => peers.size), 0);
      await seed.evaluate(() => releaseConsentUpload());
      await waitFor(receiver, () => localMedia?.videoBlob && p2pStatus?.state === 'done', 15000);
      assert.equal(await seed.evaluate(() => uploadedBytes), 0);
      assert.equal(await receiver.evaluate(() => p2pStatus.p2p), 0); assert.ok(await receiver.evaluate(() => p2pStatus.http > 0));
    } finally { await receiver?.browserContext().close(); await seed.browserContext().close(); }
  });
  test('declined clients exchange live editor cursors over Socket.IO without creating WebRTC', async () => {
    const page = await player({ audioExpanded: false });
    try {
      await waitFor(page, () => p2pConsentDialog.open); await page.click('#p2pConsentDecline');
      await host.evaluate(() => setStudioMode('edit')); await waitFor(page, () => session.mode === 'edit' && DublineCursorPresence.stats().actors > 0);
      const actor = await page.evaluate(() => socket.id);
      await waitFor(host, () => session.mode === 'edit' && DublineCursorPresence.stats().actors > 0);
      const point = await page.$eval('.track-row[data-character] .track-timeline', node => { const r = node.getBoundingClientRect(); return { x: r.left + 80, y: r.top + 35 }; });
      await page.mouse.move(point.x, point.y);
      await waitFor(host, actor => DublineCursorPresence.samples.get(actor)?.packet.active, 5000, actor);
      assert.equal((await state(page)).created, 0); assert.equal(await host.evaluate(() => DublineCursorPresence.stats().connections), 0);
    } finally { await host.evaluate(() => setStudioMode('dub')); await page.browserContext().close(); }
  });
  test('room PIN entry finishes before the consent prompt and no peer starts during authentication', async () => {
    const secured = await startServer({ DUBLINE_DESKTOP_ROOM: 'main', DUBLINE_DESKTOP_HOST_TOKEN: 'consent-host', DUBLINE_ROOM_PIN: 'ABCD' });
    const page = await openPlayer(browser, secured.url('main'), 'PIN guest', { p2pConsent: null });
    try {
      await waitFor(page, () => passwordModal.style.display === 'flex');
      assert.equal(await page.evaluate(() => p2pConsentDialog.open || p2pEnabled || peers.size > 0), false);
      await page.type('#passwordInput', 'ABCD'); await page.click('#passwordModal button[type=submit]');
      await waitFor(page, () => p2pConsentDialog.open && passwordModal.style.display === 'none');
      assert.equal(await page.evaluate(() => p2pAllowed() || peers.size > 0), false);
    } finally { await page.browserContext().close(); await secured.cleanup(); }
  });
  test('a decision in another tab closes the pending prompt and disabling stays consistent across tabs', async () => {
    const page = await player();
    try {
      await waitFor(page, () => p2pConsentDialog.open);
      const other = await openPlayer(browser, server.url(room, 'dubline.test'), 'Shared tab', { context: page.browserContext(), p2pConsent: null });
      await waitFor(other, () => p2pConsentDialog.open); await other.click('#p2pConsentAccept');
      await waitFor(page, () => p2pConsent === 'accepted' && settingsP2P.checked && !p2pConsentDialog.open);
      await page.bringToFront();
      await settings(page); await page.click('.switch-ui:has(#settingsP2P)');
      await waitFor(other, () => !p2pEnabled && !settingsP2P.checked && !peers.size);
      assert.equal(await other.evaluate(() => p2pConsent), 'accepted');
    } finally { await page.browserContext().close(); }
  });
});
