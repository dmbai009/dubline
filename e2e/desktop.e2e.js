// Desktop-only invitation controls, exercised with a safe mock of the Electron preload bridge.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skipReason, launchBrowser, startServer, waitFor } = require('./helpers');

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
      window.dublineDesktop = {
        getStatus: async () => ({
          isDesktop: true,
          room: 'desktop',
          pin: '7K9A',
          state: 'ready',
          publicUrl: 'https://quiet.trycloudflare.com'
        }),
        copyText: async value => {
          window.__desktopClipboard = String(value);
          return true;
        },
        clearAllData: async () => true,
        onTunnelStatus: () => () => {}
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
});
