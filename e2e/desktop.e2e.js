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
    await page.setViewport({ width: 1280, height: 900 });
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
        connections: {
          cloudflare: { enabled: true, state: 'ready', publicUrl: 'https://quiet.trycloudflare.com' },
          porthole: { state: 'waitingGuest', publicUrl: 'http://localhost:38500' },
          vpn: { state: 'waitingGuest', publicUrl: 'http://26.10.20.30:38500', provider: 'radmin' }
        },
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
        setCloudflareEnabled: async enabled => {
          __desktopStatus.connections.cloudflare = { enabled, state: enabled ? 'ready' : 'idle', publicUrl: enabled ? 'https://new.trycloudflare.com' : '' };
          return { ...__desktopStatus };
        },
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
    // Desktop status can arrive before the room handshake. Complete mandatory
    // dialogs before testing the invitation, which closes on outside focus.
    await waitFor(page, () => getComputedStyle(nickModal).display === 'flex');
    await page.type('#modalNickInput', 'Desktop host');
    await page.click('#nickForm button[type=submit]');
    await waitFor(page, () => amHost() && getComputedStyle(helpModal).display === 'flex');
    await page.click('#helpModal [data-i18n="help.ok"]');
    await waitFor(page, () => p2pConsentDialog.open);
    await page.click('#p2pConsentDecline');
    assert.equal(await page.evaluate(() => p2pEnabled || peers.size > 0 || settingsP2P.checked), false);
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

    await page.click('#desktopInviteToggle');
    assert.equal(await page.$eval('.desktop-invite-details', element => getComputedStyle(element).display), 'flex');
    await page.click('#desktopCopyAllBtn');
    const copied = await page.evaluate(() => window.__desktopClipboard);
    assert.match(copied, /https:\/\/quiet\.trycloudflare\.com\/\?room=desktop/);
    assert.match(copied, /7K9A/);
    assert.equal(await page.$eval('#desktopPinCode', element => element.textContent), '••••');

    await page.click('#desktopInviteToggle');
    assert.equal(await page.$eval('.desktop-invite-details', element => getComputedStyle(element).display), 'none');
  });

  test('switches the connection method without leaving the room', async () => {
    await page.click('#desktopConnectionSettings');
    await page.click('[data-hosting-mode="vpn"]');
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
    for (const language of ['ru', 'uk', 'en']) {
      for (const [mode, url] of [['cloudflare', 'https://quiet.trycloudflare.com'], ['porthole', 'http://localhost:38500'], ['vpn', 'http://26.10.20.30:38500']]) {
        await page.evaluate((language, mode, url) => {
          i18n.setLanguage(language);
          Object.assign(__desktopStatus, { mode, publicUrl: url, state: 'ready' });
          handleDesktopStatus(__desktopStatus);
          selectDesktopInviteMode(mode);
          if (desktopInviteCollapsed) toggleDesktopInvitePanel();
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

  test('connection tabs only change displayed information and never start tools or stop Cloudflare', async () => {
    await page.evaluate(() => {
      window.__modeCalls = 0; window.__oldSetHostingMode = dublineDesktop.setHostingMode;
      dublineDesktop.setHostingMode = () => { __modeCalls++; throw Error('Tabs must not change hosting'); };
      openHostingModal();
    });
    await page.click('[data-hosting-mode=porthole]');
    await page.click('[data-hosting-mode=cloudflare]');
    assert.equal(await page.$eval('[data-hosting-mode=cloudflare]', node => node.classList.contains('active')), true);
    await page.click('[data-hosting-mode=vpn]');
    assert.equal(await page.$eval('[data-hosting-mode=vpn]', node => node.classList.contains('active')), true);
    assert.equal(await page.evaluate(() => __modeCalls), 0);
    assert.equal(await page.evaluate(() => desktopConnection('cloudflare').enabled), true);
    await page.evaluate(() => { dublineDesktop.setHostingMode = __oldSetHostingMode; });
  });
  test('popover keeps header geometry, masks PIN, closes by keyboard/outside and has independent connection settings', async () => {
    await page.evaluate(() => { closeHostingModal(); closeSettingsModal(); closeDesktopInvite(false); });
    for (const [width, height] of [[1024, 768], [1280, 720], [1920, 1080]]) {
      await page.setViewport({ width, height });
      const before = await page.$eval('header', node => ({ height: node.getBoundingClientRect().height, room: document.querySelector('.room-badge').getBoundingClientRect().x }));
      await page.click('#desktopInviteToggle');
      const result = await page.evaluate(() => {
        const header = document.querySelector('header').getBoundingClientRect(), pop = document.getElementById('desktopInvitePopover'), box = pop.getBoundingClientRect();
        return { height: header.height, room: document.querySelector('.room-badge').getBoundingClientRect().x, left: box.left, right: box.right, bottom: box.bottom, top: box.top, fixed: getComputedStyle(pop).position, parent: pop.parentElement.tagName };
      });
      assert.equal(result.height, before.height); assert.equal(result.room, before.room); assert.equal(result.fixed, 'fixed'); assert.equal(result.parent, 'BODY');
      assert.ok(result.left >= 0 && result.right <= width && result.top >= 0 && result.bottom <= height, JSON.stringify(result));
      await page.click('#desktopPinEye'); assert.equal(await page.$eval('#desktopPinCode', node => node.textContent), '7K9A');
      await page.keyboard.press('Escape'); assert.equal(await page.$eval('#desktopPinCode', node => node.textContent), '••••');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'desktopInviteToggle');
      await page.click('#desktopInviteToggle'); assert.equal(await page.$eval('#desktopPinCode', node => node.textContent), '••••');
      await page.click('#desktopConnectionSettings');
      assert.equal(await page.$eval('#desktopInvitePopover', node => node.hidden), true);
      assert.equal(await page.$eval('#hostingModal', node => getComputedStyle(node).display), 'flex'); await page.evaluate(() => closeHostingModal());
      await page.click('#desktopInviteToggle'); await page.click('.brand'); assert.equal(await page.$eval('#desktopInvitePopover', node => node.hidden), true);
    }
  });
  test('Cloudflare can be disabled while VPN remains copyable; status errors never open the menu or reveal PIN', async () => {
    await page.evaluate(() => { closeDesktopInvite(false); selectDesktopInviteMode('cloudflare'); });
    await page.click('#desktopInviteToggle'); await page.click('#desktopCloudflareToggle');
    await waitFor(page, () => desktopConnection('cloudflare').state === 'idle');
    assert.equal(await page.$eval('#desktopCopyBtn', node => node.disabled), true);
    assert.equal(await page.$eval('#desktopInviteUrl', node => node.value), '');
    await page.click('[data-invite-mode=vpn]'); await page.click('#desktopCopyBtn');
    assert.equal(await page.evaluate(() => __desktopClipboard), 'http://26.10.20.30:38500/?room=desktop');
    await page.click('[data-invite-mode=cloudflare]'); await page.click('#desktopCloudflareToggle');
    await waitFor(page, () => desktopConnection('cloudflare').state === 'ready'); await page.click('#desktopCopyBtn');
    assert.equal(await page.evaluate(() => __desktopClipboard), 'https://new.trycloudflare.com/?room=desktop');
    await page.keyboard.press('Escape');
    await page.evaluate(() => handleDesktopStatus({ ...__desktopStatus, state: 'error', error: 'Connection stopped' }));
    assert.equal(await page.$eval('#desktopInvitePopover', node => node.hidden), true);
    assert.equal(await page.$eval('#desktopPinCode', node => node.textContent), '••••');
    assert.equal(await page.$eval('#hostingModal', node => getComputedStyle(node).display), 'none');
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
