// Desktop-only invitation controls, exercised with a safe mock of the Electron preload bridge.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, launchBrowser, startServer, waitFor, openPlayer, loadFixture } = require('./helpers');

describe('guest application version warning', { skip: skipReason }, () => {
  let server, browser;
  const version = require('../package.json').version;
  before(async () => { server = await startServer(); browser = await launchBrowser(server.port); });
  after(async () => { await browser?.close(); await server?.cleanup(); });
  async function guest(appVersion, name) {
    return openPlayer(browser, server.url('guest-version'), name, { beforeLoad: async page => {
      if (appVersion) await page.setUserAgent(await browser.userAgent() + ' Dubline/' + appVersion + ' Electron/44.5.0');
    } });
  }
  test('host reports its real version; a guest with a different installed app can connect and sees both versions', async () => {
    const page = await guest('1.3.0', 'Old guest');
    try {
      await waitFor(page, () => document.getElementById('guestVersionWarning')?.classList.contains('show'));
      assert.match(await page.$eval('#guestVersionWarning', node => node.textContent), /1\.3\.0/);
      assert.ok((await page.$eval('#guestVersionWarning', node => node.textContent)).includes(version));
      await waitFor(page, () => socket.connected && !!session);
      for (const width of [360, 1280]) {
        await page.setViewport({ width, height: 800 });
        for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) for (const language of ['en', 'ru', 'uk']) {
          await page.evaluate(async (theme, language) => { document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(language); }, theme, language);
          const layout = await page.$eval('#guestVersionWarning', node => {
            const box = node.getBoundingClientRect();
            return { left: box.left, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight, overflow: node.scrollWidth - node.clientWidth, title: node.querySelector('strong').textContent };
          });
          assert.ok(layout.left >= 0 && layout.right <= layout.width && layout.bottom <= layout.height && layout.overflow <= 1, JSON.stringify(layout));
          assert.match(layout.title, /versions differ|версии|Версии|Версії/);
          if (process.env.DUBLINE_QA_SCREENSHOTS && width === 360 && language === 'ru' && ['light', 'midnight'].includes(theme)) {
            const fs = require('node:fs'), path = require('node:path'); fs.mkdirSync(process.env.DUBLINE_QA_SCREENSHOTS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.DUBLINE_QA_SCREENSHOTS, 'guest-version-' + theme + '.png') });
          }
        }
      }
      await page.click('#guestVersionWarning button');
      assert.equal(await page.$eval('#guestVersionWarning', node => node.classList.contains('show')), false);
      await page.evaluate(() => socket.disconnect()); await page.evaluate(() => socket.connect());
      await waitFor(page, () => socket.connected && !editorNeedsResync);
      await page.evaluate(() => new Promise(resolve => socket.emit('time_sync', Date.now(), resolve)));
      assert.equal(await page.$eval('#guestVersionWarning', node => node.classList.contains('show')), false);
      await page.evaluate(() => socket.listeners('host_version').forEach(listener => listener({ version: '1.4.0-beta.9' })));
      assert.equal(await page.$eval('#guestVersionWarning', node => node.classList.contains('show')), true);
      assert.match(await page.$eval('#guestVersionWarning', node => node.textContent), /1\.4\.0-beta\.9/);
      await page.evaluate(() => socket.listeners('host_version').forEach(listener => listener({ version: '<img src=x onerror=alert(1)>' })));
      assert.equal(await page.$('#guestVersionWarning img'), null);
      assert.deepEqual(page.errors, []);
    } finally { await page.browserContext().close(); }
  });
  test('matching app versions and ordinary browser guests do not see a warning', async () => {
    for (const appVersion of [version, null]) {
      const page = await guest(appVersion, appVersion ? 'Same version' : 'Browser guest');
      try {
        await waitFor(page, () => socket.connected && !!session);
        await page.evaluate(() => new Promise(resolve => socket.emit('time_sync', Date.now(), resolve)));
        assert.equal(await page.evaluate(() => !!document.querySelector('#guestVersionWarning.show')), false);
        assert.deepEqual(page.errors, []);
      } finally { await page.browserContext().close(); }
    }
  });
});

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
          vpn: { state: 'waitingGuest', publicUrl: 'http://26.10.20.30:38500', provider: 'radmin' },
          custom: { state: 'manual', publicUrl: '' }
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
        getUpdatePreferences: async () => ({ supported: true, experimental: localStorage.getItem('qa-experimental') === 'true' }),
        setExperimentalUpdates: async value => {
          if (window.__preferenceError) return { ok: false, code: window.__preferenceError };
          localStorage.setItem('qa-experimental', String(value)); return { ok: true, experimental: value };
        },
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

  test('experimental update setting wraps in every theme/language and restores the switch on busy/save errors', async () => {
    await page.evaluate(() => { openSettingsModal(); switchSettingsTab('user'); openSettingsCategory('user', 'interface'); });
    await waitFor(page, () => !!document.getElementById('experimentalUpdates'));
    assert.equal(await page.$eval('#experimentalUpdates', node => node.checked), false);
    for (const width of [900, 1280]) {
      await page.setViewport({ width, height: 900 });
      for (const theme of ['midnight', 'graphite', 'light', 'ocean', 'forest', 'sunset']) for (const language of ['en', 'ru', 'uk']) {
        await page.evaluate(async (theme, language) => { document.documentElement.dataset.theme = theme; await DublineI18n.setLanguage(language); }, theme, language);
        await page.$eval('.update-channel', node => node.scrollIntoView({ block: 'center' }));
        const layout = await page.$eval('.update-channel', node => {
          const box = node.getBoundingClientRect(), label = node.querySelector('span').getBoundingClientRect(), input = node.querySelector('input').getBoundingClientRect();
          return { overflow: node.scrollWidth - node.clientWidth, right: box.right, viewport: innerWidth, gap: input.left - label.right, text: node.textContent };
        });
        assert.ok(layout.overflow <= 1 && layout.right <= layout.viewport && layout.gap >= 8, JSON.stringify({ width, theme, language, ...layout }));
        assert.match(layout.text, /unstable|нестабильно|нестабільно/);
        if (process.env.DUBLINE_QA_SCREENSHOTS && width === 900 && language === 'ru') {
          const fs = require('node:fs'), path = require('node:path');
          fs.mkdirSync(process.env.DUBLINE_QA_SCREENSHOTS, { recursive: true });
          await page.screenshot({ path: path.join(process.env.DUBLINE_QA_SCREENSHOTS, theme + '.png') });
        }
      }
    }
    await page.focus('#experimentalUpdates'); await page.keyboard.press('Space');
    await waitFor(page, () => experimentalUpdates.checked && !experimentalUpdates.disabled);
    for (const code of ['busy', 'save-failed']) {
      await page.evaluate(code => window.__preferenceError = code, code);
      await page.click('#experimentalUpdates');
      await waitFor(page, () => !experimentalUpdates.disabled && experimentalUpdates.checked);
      assert.match(await page.$eval('#experimentalUpdatesHelp', node => node.textContent), code === 'busy' ? /Дочекайтеся/ : /Не вдалося/);
    }
    await page.evaluate(() => { window.__preferenceError = ''; });
    await page.click('#experimentalUpdates'); await waitFor(page, () => !experimentalUpdates.disabled && !experimentalUpdates.checked);
    await page.evaluate(async () => { await DublineI18n.setLanguage('en'); document.documentElement.dataset.theme = 'midnight'; closeSettingsModal(); });
    await page.setViewport({ width: 1280, height: 900 });
    const guest = await browser.newPage();
    try {
      // New pages have no desktop bridge; browser participants cannot configure the host updater.
      await guest.goto(server.url('browser-guest'), { waitUntil: 'networkidle0' });
      assert.equal(await guest.$('.update-channel'), null);
    } finally { await guest.close(); }
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

  test('custom instructions use the actual port, copy it and PIN separately, and never expose a local URL as an invitation',async()=>{
    for(const language of ['en','ru','uk']){
      await page.evaluate(async language=>{await i18n.setLanguage(language);openHostingModal();},language);
      await page.click('[data-hosting-mode=custom]');
      assert.equal(await page.$eval('#desktopHostingInstructions',node=>node.children.length),3);
      assert.match(await page.$eval('#desktopHostingInstructions',node=>node.textContent),/127\.0\.0\.1:38500/);
      assert.equal(await page.$eval('#desktopCustomPortWarning',node=>node.hidden),false);
      assert.equal(await page.$eval('#desktopOpenToolBtn',node=>getComputedStyle(node).display),'none');
      assert.equal(await page.$eval('#desktopRetryHostingBtn',node=>getComputedStyle(node).display),'none');
      await page.click('#desktopCopyPortBtn');assert.equal(await page.evaluate(()=>__desktopClipboard),'38500');
      await page.evaluate(()=>closeHostingModal());await page.click('#desktopInviteToggle');
      assert.equal(await page.$eval('#desktopInviteLinkRow',node=>node.hidden),true);
      assert.equal(await page.$eval('#desktopCustomTunnelGuide',node=>node.hidden),false);
      assert.equal(await page.evaluate(()=>desktopPublicInviteUrl()),'');
      await page.click('#desktopCopyAllBtn');assert.equal(await page.evaluate(()=>__desktopClipboard),'7K9A');
      assert.equal(await page.$eval('#desktopPinCode',node=>node.textContent),'••••');
      await page.evaluate(()=>{__desktopStatus.port=38573;handleDesktopStatus(__desktopStatus);});
      await page.click('#desktopCustomTunnelGuide [data-custom-copy-port]');assert.equal(await page.evaluate(()=>__desktopClipboard),'38573');
      assert.match(await page.$eval('#desktopCustomInstructions',node=>node.textContent),/127\.0\.0\.1:38573/);
      await page.evaluate(()=>{__desktopStatus.port=0;__desktopClipboard='';handleDesktopStatus(__desktopStatus);});
      assert.equal(await page.$eval('#desktopCustomTunnelGuide [data-custom-copy-port]',node=>node.disabled),true);
      await page.evaluate(()=>copyDesktopPort());assert.equal(await page.evaluate(()=>__desktopClipboard),'');
      await page.evaluate(()=>{__desktopStatus.port=38500;handleDesktopStatus(__desktopStatus);closeDesktopInvite(false);});
    }
    await page.evaluate(()=>{selectDesktopInviteMode('cloudflare');i18n.setLanguage('en');});
    assert.match(await page.evaluate(()=>desktopPublicInviteUrl()),/^https:/);
    assert.equal(await page.$eval('#desktopInviteLinkRow',node=>node.hidden),false);
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
