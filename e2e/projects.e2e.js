const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { readProject } = require('../server/projects');
const { skipReason, startServer, launchBrowser, openPlayer, loadFixture, recordTake, waitFor, waitUntil } = require('./helpers');

describe('portable project browser workflow', { skip: skipReason, timeout: 90000 }, () => {
  let server, browser, host, guest, dir;
  before(async () => {
    server = await startServer(); browser = await launchBrowser(server.port);
    host = await openPlayer(browser, server.url('projects'), 'Host');
    guest = await openPlayer(browser, server.url('projects'), 'Guest');
    await loadFixture(host);
    await waitFor(guest, () => session?.loaded);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dubline-project-browser-'));
    const cdp = await host.createCDPSession();
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
  });
  after(async () => {
    await browser?.close(); await server?.cleanup();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('save through the actual Files UI, reopen with the file input, and retain a real recording after reload', async () => {
    await host.evaluate(() => { socket.emit('claim_line', { sessionId: session.activeSessionId,  lineId: 1 }); });
    await waitFor(host, () => session.lines[0].claimedBy === myName);
    await recordTake(host, 1);
    await waitFor(host, () => session.lines[0].audioUrl && pendingTakeLines.size === 0);
    await host.evaluate(() => setMyLatency(42));
    await waitFor(host, () => session.latency[myName] === 42);
    const old = await host.evaluate(() => ({ id: session.activeSessionId, title: session.title,
      line: { ...session.lines[0] }, audibleStart: takeStartTime(session.lines[0]), count: session.sessionList.length }));
    await host.evaluate(() => { openFilesModal(); switchFilesTab('export'); });
    const download = host.waitForResponse(response => response.url().includes('/api/export-project'), { timeout: 15000 });
    await host.click('#projectExportBtn');
    const response = await download;
    assert.equal(response.status(), 200);
    await waitUntil(() => fs.readdirSync(dir).some(name => name.endsWith('.dubline')), 15000);
    const bytes = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(name => name.endsWith('.dubline'))));
    const project = readProject(bytes);
    assert.equal(project.manifest.project.lines[0].take.recordedBy, 'Host');
    assert.ok(project.files.get(project.manifest.project.lines[0].take.asset).length > 100);
    const filename = path.join(dir, 'Проект.dubline'); fs.writeFileSync(filename, bytes);
    await waitFor(host, () => document.getElementById('projectExportStatus').textContent.includes('Project download started'));
    await host.evaluate(() => switchFilesTab('import'));
    const imported = host.waitForResponse(response => response.url().includes('/api/import-project'), { timeout: 15000 });
    await (await host.$('#projectInput')).uploadFile(filename);
    assert.equal((await imported).status(), 200);
    await waitFor(host, id => session.activeSessionId !== id && session.lines[0].audioUrl, 15000, old.id);
    assert.equal(await host.evaluate(() => session.sessionList.length), old.count + 1);
    assert.equal(await host.evaluate(() => session.title), old.title);
    assert.equal(await host.evaluate(() => session.lines[0].recordedBy), 'Host');
    assert.equal(await host.evaluate(() => takeStartTime(session.lines[0])), old.audibleStart);
    await host.reload();
    await waitFor(host, id => session?.loaded && session.activeSessionId !== id && session.lines[0].audioUrl, 15000, old.id);
    const playable = await host.evaluate(async () => !!(await getProcessedTake(session.lines[0])));
    assert.equal(playable, true);
  });

  test('corrupt project reports an error without changing the scene; guest sees disabled project actions', async () => {
    const id = await host.evaluate(() => session.activeSessionId);
    const broken = new AdmZip(); broken.addFile('project.json', Buffer.from('{"format":"dubline-project","formatVersion":999}'));
    const filename = path.join(dir, 'bad.dubline'); fs.writeFileSync(filename, broken.toBuffer());
    await host.evaluate(() => openFilesModal());
    await (await host.$('#projectInput')).uploadFile(filename);
    await waitFor(host, () => document.getElementById('projectImportStatus').style.color === 'var(--danger)' ||
      document.getElementById('projectImportStatus').textContent.includes('not supported'));
    assert.equal(await host.evaluate(() => session.activeSessionId), id);
    await guest.evaluate(() => { openFilesModal(); switchFilesTab('export'); });
    assert.equal(await guest.$eval('#projectExportBtn', button => button.disabled), true);
    assert.equal(await guest.$eval('#projectInput', input => input.disabled), true);
  });

  test('limits and automatic optimization are visible in EN/RU/UK',async()=>{
    await host.evaluate(()=>{openFilesModal();switchFilesTab('import');});
    for(const language of ['en','ru','uk']){
      const labels=await host.evaluate(async language=>{await DublineI18n.setLanguage(language);return ['customImport.limits','project.openHelp','project.saveHelp'].map(key=>document.querySelector('[data-i18n="'+key+'"]').textContent);},language);
      for(const text of labels){assert.match(text,/300/);assert.doesNotMatch(text,/384/);}
    }
    await host.evaluate(()=>DublineI18n.setLanguage('en'));
    const text=await host.$eval('[data-i18n="customImport.limits"]',element=>element.textContent);
    assert.match(text,/optimized automatically/);assert.match(text,/original is kept/);
  });

  test('no browser script errors', () => { assert.deepEqual(host.errors, []); assert.deepEqual(guest.errors, []); });
});
