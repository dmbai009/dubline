// Desktop-only invitation controls, exercised with a safe mock of the Electron preload bridge.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, launchBrowser, startServer, waitFor, openPlayer, loadFixture } = require('./helpers');

describe('desktop invitation', { skip: skipReason }, () => {
  let server;
  let browser;
  let page;

  before(async () => {
    server = await startServer();
    browser = await launchBrowser(server.port);
    page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      window.__desktopClipboard = '';
      window.__desktopStatus = {
        isDesktop: true,
        room: 'desktop',
        pin: '7K9A',
        state: 'ready',
        mode: 'cloudflare',
        port: 38500,
        publicUrl: 'https://quiet.trycloudflare.com',
        tools: {}
      };
      window.dublineDesktop = {
        getStatus: async () => ({ ...window.__desktopStatus }),
        setHostingMode: async mode => {
          window.__desktopStatus = {
            ...window.__desktopStatus,
            mode,
            provider: mode === 'vpn' ? 'radmin' : '',
            state: 'waitingGuest',
            publicUrl: mode === 'vpn' ? 'http://26.10.20.30:38500' : `http://localhost:38500`
          };
          return { ...window.__desktopStatus };
        },
        retryHosting: async () => ({ ...window.__desktopStatus }),
        openNetworkTool: async () => true,
        copyText: async value => {
          window.__desktopClipboard = String(value);
          return true;
        },
        clearAllData: async () => true,
        onTunnelStatus: () => () => {},
        getUpdateStatus: async () => ({ state: 'available', currentVersion: '1.1.0', version: '1.2.0', url: 'https://github.com/dmbai009/dubline/releases/tag/v1.2.0', dismissed: false }),
        openUpdate: async () => { window.__updateOpened = true; return true; },
        openProject: async () => { window.__projectOpened = true; return true; },
        dismissUpdate: async () => true,
        onUpdateStatus: () => () => {}
      };
    });
    await page.goto(server.url('desktop'), { waitUntil: 'domcontentloaded' });
    await waitFor(page, () => document.body.classList.contains('desktop-mode')
      && !document.getElementById('desktopCopyAllBtn').disabled);
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) await server.cleanup();
  });

  test('starts collapsed and copies the hidden PIN together with the link', async () => {
    const initial = await page.evaluate(() => ({
      collapsed: document.getElementById('desktopInvitePanel').classList.contains('collapsed'),
      details: getComputedStyle(document.querySelector('.desktop-invite-details')).display,
      pin: document.getElementById('desktopPinCode').textContent
    }));
    assert.equal(initial.collapsed, true);
    assert.equal(initial.details, 'none');
    assert.equal(initial.pin, '••••');

    await page.$eval('#desktopCopyAllBtn', button => button.click());
    const copied = await page.evaluate(() => window.__desktopClipboard);
    assert.match(copied, /https:\/\/quiet\.trycloudflare\.com\/\?room=desktop/);
    assert.match(copied, /7K9A/);
    assert.equal(await page.$eval('#desktopPinCode', element => element.textContent), '••••');

    await page.$eval('.desktop-invite-toggle', button => button.click());
    assert.equal(await page.$eval('.desktop-invite-details', element => getComputedStyle(element).display), 'flex');
  });

  test('switches the connection method without leaving the room', async () => {
    await page.evaluate(() => openHostingModal());
    await page.$eval('[data-hosting-mode="vpn"]', button => button.click());
    await waitFor(page, () => document.querySelector('[data-hosting-mode="vpn"]').classList.contains('active'));
    const result = await page.evaluate(() => ({
      modal: getComputedStyle(document.getElementById('hostingModal')).display,
      mode: document.getElementById('desktopHostingModeTitle').textContent,
      port: document.getElementById('desktopHostingPort').textContent,
      url: document.getElementById('desktopInviteUrl').value
    }));
    assert.equal(result.modal, 'flex');
    assert.equal(result.mode, 'Radmin VPN');
    assert.equal(result.port, '38500');
    assert.match(result.url, /^http:\/\/26\.10\.20\.30:38500\/\?room=desktop$/);
  });

  test('copies exactly two invitation lines in every language and connection mode', async () => {
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluate(() => closeHostingModal());
    await page.type('#modalNickInput', 'Desktop host');
    await page.click('#nickForm button[type=submit]');
    await waitFor(page, () => amHost());
    await page.click('#helpModal [data-i18n="help.ok"]');
    for (const language of ['ru', 'uk', 'en']) {
      for (const [mode, url] of [['cloudflare', 'https://quiet.trycloudflare.com'], ['porthole', 'http://localhost:38500'], ['vpn', 'http://26.10.20.30:38500']]) {
        await page.evaluate((language, mode, url) => {
          i18n.setLanguage(language);
          Object.assign(__desktopStatus, { mode, publicUrl: url, state: 'ready' });
          handleDesktopStatus(__desktopStatus);
        }, language, mode, url);
        await page.locator('#desktopCopyAllBtn').click();
        assert.equal(await page.evaluate(() => __desktopClipboard), `${url}/?room=desktop\nPIN: 7K9A`);
        await page.$eval('.desktop-invite-toggle', button => { if (document.getElementById('desktopInvitePanel').classList.contains('collapsed')) button.click(); });
        await page.locator('#desktopCopyBtn').click();
        assert.equal(await page.evaluate(() => __desktopClipboard), `${url}/?room=desktop`, 'link-only copy is unchanged');
      }
    }
    await page.evaluate(() => i18n.setLanguage('en'));
  });

  test('single promotion clears solo state; tabs remain clickable during delayed requests and old replies cannot change the selected mode', async () => {
    await page.evaluate(() => {
      handleDesktopStatus({ ...__desktopStatus, mode:'single', singlePlayer:true, state:'local' });
      window.__pendingModes = [];
      window.__oldSetHostingMode = dublineDesktop.setHostingMode;
      dublineDesktop.setHostingMode = mode => new Promise(resolve => __pendingModes.push({ mode, resolve }));
      openHostingModal();
    });
    await page.click('[data-hosting-mode=porthole]');
    assert.equal(await page.$eval('[data-hosting-mode=cloudflare]', node => node.disabled), false);
    await page.click('[data-hosting-mode=cloudflare]');
    assert.equal(await page.$eval('[data-hosting-mode=cloudflare]', node => node.classList.contains('active')), true);
    await page.click('[data-hosting-mode=vpn]');
    await page.evaluate(() => __pendingModes[2].resolve({ ...__desktopStatus, mode:'vpn', singlePlayer:false, state:'waitingGuest' }));
    await waitFor(page, () => desktopInviteState.mode === 'vpn' && !desktopInviteState.singlePlayer);
    await page.evaluate(() => { __pendingModes[1].resolve({ ...__desktopStatus, mode:'cloudflare' }); __pendingModes[0].resolve({ ...__desktopStatus, mode:'porthole' }); });
    assert.equal(await page.$eval('[data-hosting-mode=vpn]', node => node.classList.contains('active')), true);
    assert.equal(await page.$eval('#desktopInvitePanel', node => getComputedStyle(node).display), 'flex');
    await page.evaluate(() => { dublineDesktop.setHostingMode = __oldSetHostingMode; });
  });

  test('keeps the update notice optional and non-blocking', async () => {
    await waitFor(page, () => document.getElementById('appUpdateBanner').classList.contains('show'));
    assert.match(await page.$eval('#appUpdateVersion', node => node.textContent), /1\.2\.0/);
    assert.equal(await page.$eval('#desktopAboutVersion', node => node.textContent), 'Dubline v1.1.0');
    await page.evaluate(() => openAppUpdate());
    await waitFor(page, () => window.__updateOpened === true);
    await page.evaluate(() => dismissAppUpdate());
    assert.equal(await page.$eval('#appUpdateBanner', node => node.classList.contains('show')), false);
    await page.evaluate(() => openProjectPage());
    await waitFor(page, () => window.__projectOpened === true);
  });

  test('desktop host can unban through the visible settings button; guests and moderators cannot', async () => {
    await page.setViewport({ width: 1280, height: 900 });
    await page.evaluate(() => { closeHostingModal(); closeSettingsModal(); });
    await loadFixture(page);
    const guest = await openPlayer(browser, server.url('desktop'), 'Guest');
    const victim = await openPlayer(browser, server.url('desktop'), 'Victim');
    try {
      await waitFor(page, () => lastOnlineUsers.includes('Guest') && lastOnlineUsers.includes('Victim'));
      const card = '[data-lobby-key="player:Victim"]';
      await page.click(`${card} .participant-menu summary`);
      await page.click(`${card} .btn-delete`);
      await waitFor(page, () => document.querySelector('dialog[open]'));
      await page.click('#textPromptSave');
      await waitFor(victim, () => deniedModal.style.display === 'flex');
      await waitFor(page, () => session.bannedCount === 1);
      await page.evaluate(() => { openSettingsModal(); switchSettingsTab('player'); openSettingsCategory('player', 'room'); });
      assert.equal(await page.$eval('#roomSecuritySettings', node => getComputedStyle(node).display), 'none', 'password stays hidden on desktop');
      assert.ok(await page.$eval('#unbanBtn', node => node.getBoundingClientRect().height > 0 && !node.disabled));
      await guest.evaluate(() => { openSettingsModal(); switchSettingsTab('player'); });
      assert.equal(await guest.$eval('#roomBanSettings', node => getComputedStyle(node).display), 'none');
      await page.evaluate(() => closeSettingsModal());
      await page.click('[data-lobby-key="player:Guest"] .participant-menu summary');
      await page.click('[data-lobby-key="player:Guest"] .participant-menu .btn-outline');
      await waitFor(page, () => document.querySelector('dialog[open]')); await page.click('#textPromptSave');
      await waitFor(guest, () => amModerator());
      assert.equal(await guest.$eval('#roomBanSettings', node => getComputedStyle(node).display), 'none', 'moderation does not grant unban rights');
      await guest.evaluate(() => socket.emit('host_unban_all'));
      await guest.evaluate(() => new Promise(resolve => socket.emit('time_sync', Date.now(), resolve)));
      assert.equal(await page.evaluate(() => session.bannedCount), 1, 'server still rejects moderator unban');
      await victim.reload(); await waitFor(victim, () => deniedModal.style.display === 'flex');
      await page.evaluate(() => { openSettingsModal(); switchSettingsTab('player'); openSettingsCategory('player', 'room'); });
      await page.locator('#unbanBtn').click();
      await waitFor(page, () => !session.bannedCount && getComputedStyle(document.getElementById('roomBanSettings')).display === 'none');
      await victim.reload(); await waitFor(victim, () => session?.loaded && socket.connected && lastOnlineUsers.includes('Victim'));
      assert.deepEqual(guest.errors, []); assert.deepEqual(victim.errors, []);
    } finally { await guest.browserContext().close(); await victim.browserContext().close(); }
  });
});
