const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { zipFiles } = require('./tools/build-distributions');
const { PortableUpdater, validateMetadata, extractUpdate } = require('./electron-portable-update');
const { createManifest, manifestBytes, bytesHash, fileHash, verifyTree, changesBetween, safeRelative, MANIFEST_PATH } = require('./electron-managed-files');
const helper = path.join(__dirname, 'resources', 'portable-update-helper.ps1');
async function tree(folder, version, code) {
  await fsp.mkdir(path.join(folder, 'resources', 'bin'), { recursive: true });
  const marker = { schemaVersion: 1, channel: 'github-portable', version, commit: (version.endsWith('0') ? 'a' : 'b').repeat(40), electronVersion: '44.5.0', arch: 'x64', platform: 'win32' };
  await fsp.writeFile(path.join(folder, 'Dubline.exe'), 'same-runtime');
  await fsp.writeFile(path.join(folder, 'resources', 'bin', 'ffmpeg.exe'), 'same-ffmpeg');
  await fsp.writeFile(path.join(folder, 'resources', 'app.asar'), code);
  await fsp.writeFile(path.join(folder, 'resources', 'dubline-distribution.json'), JSON.stringify(marker));
  const manifest = await createManifest(folder, marker);
  await fsp.writeFile(path.join(folder, ...MANIFEST_PATH.split('/')), manifestBytes(manifest));
  return manifest;
}
async function fixture() {
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'dubline-portable-safety-'));
  const a = path.join(folder, 'A'), b = path.join(folder, 'B');
  const base = await tree(a, '1.4.0', 'code-A'), target = await tree(b, '1.4.1', 'code-B');
  const changes = changesBetween(base, target), hash = bytesHash(manifestBytes(target)), baseHash = bytesHash(manifestBytes(base));
  const patchInfo = { schemaVersion: 1, fromVersion: base.version, toVersion: target.version, requiredBaseManifestHash: baseHash,
    targetManifestHash: hash, changed: changes.changed.map(file => file.path), removed: changes.removed };
  const patchFile = path.join(folder, 'Dubline-test-Patch.zip'), fullFile = path.join(folder, 'Dubline-test-Portable.zip');
  await zipFiles(b, changes.changed.map(file => file.path), patchFile, { 'patch.json': JSON.stringify(patchInfo), [MANIFEST_PATH]: manifestBytes(target) });
  await zipFiles(b, [...target.files.map(file => file.path), MANIFEST_PATH], fullFile);
  const asset = async file => ({ asset: path.basename(file), size: (await fsp.stat(file)).size, sha256: await fileHash(file) });
  const metadata = { ...target, files: undefined, targetManifest: target, targetManifestHash: hash,
    full: await asset(fullFile), patches: [{ ...await asset(patchFile), fromVersion: base.version, requiredBaseManifestHash: baseHash }] };
  const release = { tag_name: 'v1.4.1', draft: false, prerelease: false, assets: ['portable-update.json', metadata.full.asset, metadata.patches[0].asset].map(name => ({ name,
    browser_download_url: `https://github.com/dmbai009/dubline/releases/download/v1.4.1/${name}` })) };
  const requested = [];
  const adapter = new PortableUpdater({ current: base, root: a, stagingRoot: path.join(folder, 'staging'), helper,
    busy: async () => false, shutdown: async () => {}, exit: () => {},
    json: async url => url.includes('/releases/latest') ? release : metadata,
    fetchFile: async (_url, destination, expected, progress) => {
      requested.push(expected.asset); const source = expected.asset === path.basename(patchFile) ? patchFile : fullFile;
      await fsp.copyFile(source, destination);
      assert.equal(await fileHash(destination), expected.sha256);
      progress({ percent: 100, transferred: expected.size, total: expected.size });
    } });
  return { folder, a, b, base, target, adapter, requested, metadata, patchFile, patchInfo, changes };
}
test('Portable restores a nonfatal rollback status and keeps recovery evidence on the next launch',async()=>{
  const f=await fixture();
  try{
    await f.adapter.check();const plan=f.adapter.staged.plan;
    await fsp.writeFile(path.join(f.a,'.dubline-update-journal.json'),JSON.stringify({schemaVersion:1,root:f.a,phase:'rolledBack',jobFile:f.adapter.staged.job,baseManifestHash:plan.baseManifestHash}));
    await fsp.writeFile(path.join(f.adapter.staged.folder,'update-result.json'),JSON.stringify({ok:false,recovered:true,helperLine:1}));
    let outcome;f.adapter.on('apply-result',value=>{outcome=value;});
    assert.equal(await f.adapter.resumeInterrupted(),false);assert.equal(outcome.state,'rolled-back');
    assert.equal(f.adapter.getStatus().state,'error');assert.equal(f.adapter.getStatus().recovered,true);
    assert.equal(fs.existsSync(f.adapter.staged.job),true);await verifyTree(f.a,f.base);
  }finally{await fsp.rm(f.folder,{recursive:true,force:true});}
});
test('Portable rejects malformed paths, wrong channels, architecture, downgrade, duplicate and mismatched target metadata', async () => {
  const f = await fixture();
  try {
    validateMetadata(f.metadata, f.base);
    for (const relative of ['../take.webm', 'C:/x', '/x', 'resources/x:stream', 'resources/CON.txt', 'resources/a.', 'resources/../x', 'resources\\x']) assert.throws(() => safeRelative(relative));
    for (const patch of [{ arch: 'arm64' }, { channel: 'steam' }, { version: '1.3.0' }, { schemaVersion: 2 }, { targetManifestHash: '0'.repeat(64) }]) assert.throws(() => validateMetadata({ ...f.metadata, ...patch }, f.base));
    const stage = path.join(f.folder, 'bad-stage'); await fsp.mkdir(stage);
    const badZip = path.join(f.folder, 'bad.zip');
    await zipFiles(f.b, ['Dubline.exe'], badZip, { 'unknown-user-file.txt': 'surprise' });
    await assert.rejects(extractUpdate(badZip, stage, f.target, f.target.files, null), /unsafe|Unexpected/);
  } finally { await fsp.rm(f.folder, { recursive: true, force: true }); }
});
test('Portable stages changed files only, falls back to full for modified base, and preserves unknown projects through the actual external helper', async () => {
  for (const modified of [false, true]) {
    const f = await fixture();
    try {
      // Reproduce pwsh -> Node -> powershell.exe inheriting an incompatible
      // Utility module ahead of the Windows PowerShell built-in modules in CI.
      const moduleRoot = path.join(f.folder, 'pwsh-modules');
      const utility = path.join(moduleRoot, 'Microsoft.PowerShell.Utility');
      await fsp.mkdir(utility, { recursive: true });
      await fsp.writeFile(path.join(utility, 'Microsoft.PowerShell.Utility.psd1'), "@{ RootModule='Utility.psm1'; NestedModules=@('Microsoft.PowerShell.Commands.Utility.dll'); ModuleVersion='99.0.0'; GUID='d66b41ca-a424-4af2-bc62-99bd6178d234'; FunctionsToExport=@('Get-FileHash'); CmdletsToExport=@('New-Object','ConvertFrom-Json','ConvertTo-Json','Start-Sleep'); AliasesToExport=@() }\n");
      await fsp.writeFile(path.join(utility, 'Utility.psm1'), "function Get-FileHash { throw 'Incompatible test Utility module.' }\nExport-ModuleMember -Function Get-FileHash\n");
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
      env.PSModulePath = [moduleRoot, path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')].join(path.delimiter);
      const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-FileHash -LiteralPath $PSHOME/powershell.exe'], { encoding: 'utf8', windowsHide: true, env });
      assert.notEqual(probe.status, 0, 'The inherited incompatible module path must reproduce the Windows PowerShell hash failure.');
      await fsp.writeFile(path.join(f.a, 'Keep мой проект.dubline'), 'user-project');
      await fsp.writeFile(path.join(f.a, 'personal.txt'), 'user-note');
      if (modified) await fsp.writeFile(path.join(f.a, 'resources', 'app.asar'), 'locally-modified');
      await f.adapter.check();
      assert.equal(f.adapter.getStatus().state, 'downloaded'); assert.equal(f.adapter.getStatus().downloadKind, modified ? 'full' : 'patch');
      assert.deepEqual(f.requested, [modified ? f.metadata.full.asset : f.metadata.patches[0].asset]);
      if (!modified) {
        assert.deepEqual(f.changes.changed.map(file => file.path), ['resources/app.asar', 'resources/dubline-distribution.json']);
        assert.equal(fs.existsSync(path.join(f.adapter.staged.plan.staged, 'resources', 'bin', 'ffmpeg.exe')), false);
        assert.equal(fs.existsSync(path.join(f.adapter.staged.plan.staged, 'Dubline.exe')), false);
      }
      assert.equal(await fsp.readFile(path.join(f.a, 'resources', 'app.asar'), 'utf8'), modified ? 'locally-modified' : 'code-A');
      const plan = f.adapter.staged.plan; plan.restart = false; plan.processes = [{ id: 2147483647 }];
      await fsp.writeFile(f.adapter.staged.job, JSON.stringify(plan));
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f.adapter.staged.helper, '-JobFile', f.adapter.staged.job], { encoding: 'utf8', windowsHide: true, env });
      assert.equal(result.status, 0, result.stderr);
      const outcome = JSON.parse(await fsp.readFile(path.join(f.adapter.staged.folder, 'update-result.json'), 'utf8'));
      assert.equal(outcome.ok, true, outcome.error);
      await verifyTree(f.a, f.target);
      assert.equal(await fsp.readFile(path.join(f.a, 'Keep мой проект.dubline'), 'utf8'), 'user-project');
      assert.equal(await fsp.readFile(path.join(f.a, 'personal.txt'), 'utf8'), 'user-note');
    } finally { await fsp.rm(f.folder, { recursive: true, force: true }); }
  }
});
test('Portable helper rolls back earlier replacements when a new managed path is occupied by an unknown user file', async () => {
  const f = await fixture();
  try {
    await fsp.writeFile(path.join(f.b, 'resources', 'zzz-new.js'), 'new-app-code');
    const target = await createManifest(f.b, { ...f.target, files: undefined });
    await fsp.writeFile(path.join(f.b, ...MANIFEST_PATH.split('/')), manifestBytes(target));
    const changes = changesBetween(f.base, target);
    await fsp.writeFile(path.join(f.a, 'resources', 'zzz-new.js'), 'unknown-user-file');
    const stage = path.join(f.folder, 'rollback'); await fsp.mkdir(stage);
    const plan = { schemaVersion: 1, root: f.a, staged: f.b, base: f.base, target,
      baseManifestHash: bytesHash(manifestBytes(f.base)), targetManifestHash: bytesHash(manifestBytes(target)), full: false,
      changed: changes.changed.map(file => file.path), removed: changes.removed, restart: false, processes: [{ id: 2147483647 }] };
    const job = path.join(stage, 'job.json'); await fsp.writeFile(job, JSON.stringify(plan));
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-JobFile', job], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(await fsp.readFile(path.join(stage, 'update-result.json'), 'utf8'));
    assert.equal(outcome.ok, false); assert.equal(outcome.recovered, true, outcome.error);
    await verifyTree(f.a, f.base);
    assert.equal(await fsp.readFile(path.join(f.a, 'resources', 'zzz-new.js'), 'utf8'), 'unknown-user-file');
  } finally { await fsp.rm(f.folder, { recursive: true, force: true }); }
});
test('a killed Portable helper leaves a durable journal; the next helper restores the base and completes the target', async () => {
  const f = await fixture(); let child;
  try {
    const generated = path.join(f.b, 'resources', 'recovery-fixture'); await fsp.mkdir(generated);
    for (let index = 0; index < 150; index++) await fsp.writeFile(path.join(generated, `${String(index).padStart(3, '0')}.js`), 'new managed code');
    const target = await createManifest(f.b, { ...f.target, files: undefined });
    await fsp.writeFile(path.join(f.b, ...MANIFEST_PATH.split('/')), manifestBytes(target));
    const changes = changesBetween(f.base, target), stage = path.join(f.folder, 'recovery-job'); await fsp.mkdir(stage);
    const plan = { schemaVersion: 1, root: f.a, staged: f.b, base: f.base, target,
      baseManifestHash: bytesHash(manifestBytes(f.base)), targetManifestHash: bytesHash(manifestBytes(target)), full: false,
      changed: changes.changed.map(file => file.path), removed: changes.removed, restart: false, processes: [{ id: 2147483647 }] };
    const job = path.join(stage, 'job.json'); await fsp.writeFile(job, JSON.stringify(plan));
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-JobFile', job];
    // Pause at an exact durable boundary; do not race startup and 150 writes
    // inside a 10 s window on a loaded CI worker. Recovery uses the real helper.
    const script = await fsp.readFile(helper, 'utf8');
    const boundary = '    WriteAtomic $journalPath ($journal | ConvertTo-Json -Depth 30)';
    assert.equal(script.split(boundary).length, 2, 'one journal boundary inside the replacement loop');
    const pausedHelper = path.join(stage, 'interrupt-helper.ps1');
    const pause = [
      '    if ($journal.entries.Count -eq 5) {',
      "      WriteAtomic (Join-Path ([IO.Path]::GetDirectoryName($JobFile)) 'interrupt-ready.json') '{\"ready\":true}'",
      '      while ($true) { Start-Sleep -Milliseconds 100 }',
      '    }'
    ].join('\n');
    await fsp.writeFile(pausedHelper, script.replace(boundary, boundary + '\n' + pause));
    let stderr = '';
    child = spawn('powershell.exe', args.map(value => value === helper ? pausedHelper : value), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('exit', resolve));
    const deadline = Date.now() + 60000; let interrupted = false, observed;
    while (Date.now() < deadline) {
      try {
        const ready = JSON.parse(await fsp.readFile(path.join(stage, 'interrupt-ready.json'), 'utf8'));
        observed = JSON.parse(await fsp.readFile(path.join(f.a, '.dubline-update-journal.json'), 'utf8'));
        if (ready.ready && observed.phase === 'applying' && observed.entries.length === 5) { child.kill(); interrupted = true; break; }
      } catch (_) {}
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(interrupted, true, 'helper missed durable boundary: exit=' + child.exitCode + ', journal=' + JSON.stringify(observed) + ', stderr=' + stderr); await exited; child = null;
    assert.equal(JSON.parse(await fsp.readFile(path.join(f.a, '.dubline-update-journal.json'), 'utf8')).phase, 'applying');
    for (const entry of observed.entries.slice(0, 4)) assert.equal(await fileHash(path.join(f.a, ...entry.path.split('/'))), await fileHash(path.join(f.b, ...entry.path.split('/'))), 'the interrupted helper really replaced files');
    const resumed = spawnSync('powershell.exe', args, { windowsHide: true, encoding: 'utf8' });
    assert.equal(resumed.status, 0, resumed.stderr);
    const outcome = JSON.parse(await fsp.readFile(path.join(stage, 'update-result.json'), 'utf8'));
    assert.equal(outcome.ok, true, outcome.error); await verifyTree(f.a, target);
  } finally {
    if (child && child.exitCode === null) { const closed = new Promise(resolve => child.once('exit', resolve)); child.kill(); await closed; }
    await fsp.rm(f.folder, { recursive: true, force: true });
  }
});
