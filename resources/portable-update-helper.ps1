param([Parameter(Mandatory=$true)][string]$JobFile)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
# Node/Electron launched by pwsh can inherit PowerShell 7 module paths. This
# Windows PowerShell helper only needs the built-in modules of its own engine.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$utf8 = New-Object System.Text.UTF8Encoding($false)
$plan = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
$root = [IO.Path]::GetFullPath([string]$plan.root).TrimEnd('\')
$stage = [IO.Path]::GetFullPath([string]$plan.staged).TrimEnd('\')
$journalPath = Join-Path $root '.dubline-update-journal.json'
$lockPath = Join-Path $root '.dubline-update.lock'
$logPath = Join-Path ([IO.Path]::GetDirectoryName($JobFile)) 'update-result.json'
$rootFiles = @('Dubline.exe','chrome_100_percent.pak','chrome_200_percent.pak','d3dcompiler_47.dll','dxcompiler.dll','dxil.dll','ffmpeg.dll','icudtl.dat','libEGL.dll','libGLESv2.dll','LICENSE.electron.txt','LICENSES.chromium.html','resources.pak','snapshot_blob.bin','v8_context_snapshot.bin','vk_swiftshader.dll','vk_swiftshader_icd.json','vulkan-1.dll','notification_helper.exe')
function SafePath([string]$base, [string]$relative, [bool]$manifest = $false) {
  if (!$relative -or $relative.Length -gt 1024 -or $relative -match '[\\:\x00-\x1f]' -or $relative.StartsWith('/') -or $relative -match '\.dubline$') { throw 'Unsafe managed path.' }
  $parts = $relative.Split('/')
  foreach ($part in $parts) {
    if (!$part -or $part -eq '.' -or $part -eq '..' -or $part -match '[. ]$' -or $part -match '^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { throw 'Unsafe managed path component.' }
  }
  if (!($rootFiles -ccontains $relative) -and !$relative.StartsWith('resources/') -and !$relative.StartsWith('locales/')) { throw 'Outside managed application scope.' }
  if ($relative -eq 'resources/dubline-managed.json' -and !$manifest) { throw 'Manifest must be committed separately.' }
  $current = $base
  if (!(Test-Path -LiteralPath $current -PathType Container) -or ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe update root.' }
  foreach ($part in $parts) {
    $current = Join-Path $current $part
    if ((Test-Path -LiteralPath $current) -and ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'A managed path contains a reparse point.' }
  }
  $result = [IO.Path]::GetFullPath($current)
  if (!$result.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escapes update root.' }
  return $result
}
function Hash([string]$file) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
function WriteAtomic([string]$file, [string]$text) {
  $temp = $file + '.new'
  $bytes = $utf8.GetBytes($text)
  $stream = [IO.File]::Open($temp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  if ([IO.File]::Exists($file)) { [IO.File]::Replace($temp, $file, [System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($temp, $file) }
}
function ValidateManifest($value) {
  if ($value.schemaVersion -ne 1 -or $value.channel -ne 'github-portable' -or $value.platform -ne 'win32' -or $value.arch -ne 'x64' -or $value.version -notmatch '^\d+\.\d+\.\d+$' -or $value.commit -notmatch '^[a-f0-9]{40}$' -or $value.electronVersion -notmatch '^\d+\.\d+\.\d+$' -or $value.files.Count -lt 3 -or $value.files.Count -gt 8192) { throw 'Invalid managed manifest.' }
  $map = @{}; [long]$total = 0
  foreach ($file in $value.files) {
    $null = SafePath $root ([string]$file.path)
    if ($map.ContainsKey([string]$file.path) -or $file.size -lt 0 -or $file.size -gt 2147483648 -or $file.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid managed entry.' }
    $map[[string]$file.path] = $file; $total += [long]$file.size
  }
  if ($total -gt 8589934592 -or !$map.ContainsKey('Dubline.exe') -or !$map.ContainsKey('resources/app.asar') -or !$map.ContainsKey('resources/dubline-distribution.json')) { throw 'Incomplete managed manifest.' }
  return $map
}
function VerifyFiles([string]$base, $files) {
  foreach ($file in $files) {
    $name = SafePath $base ([string]$file.path)
    if (!(Test-Path -LiteralPath $name -PathType Leaf) -or (Get-Item -LiteralPath $name).Length -ne [long]$file.size -or (Hash $name) -ne $file.sha256) { throw ('Managed file integrity mismatch: ' + $file.path) }
  }
}
function ReplaceFile([string]$source, [string]$destination, [string]$temporaryId = '') {
  $parent = [IO.Path]::GetDirectoryName($destination)
  $null = [IO.Directory]::CreateDirectory($parent)
  if (!$temporaryId) { $temporaryId = [guid]::NewGuid().ToString('N') }
  if ($temporaryId -notmatch '^[a-f0-9]{32}$') { throw 'Invalid transaction temporary ID.' }
  $temporary = $destination + '.dubline-update-' + $temporaryId + '.new'
  if ([IO.File]::Exists($temporary)) { throw 'Update temporary path is occupied.' }
  [IO.File]::Copy($source, $temporary, $false)
  $stream = [IO.File]::Open($temporary, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try { $stream.Flush($true) } finally { $stream.Dispose() }
  try {
    if ([IO.File]::Exists($destination)) { [IO.File]::Replace($temporary, $destination, [System.Management.Automation.Language.NullString]::Value) } else { [IO.File]::Move($temporary, $destination) }
  } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}
function Rollback($journal) {
  $backup = [IO.Path]::GetFullPath([string]$journal.backup)
  if (!$backup.StartsWith($root + '\.dubline-update-backup-', [StringComparison]::OrdinalIgnoreCase) -or $journal.root -ne $root) { throw 'Unsafe recovery journal.' }
  for ($index = $journal.entries.Count - 1; $index -ge 0; $index--) {
    $entry = $journal.entries[$index]
    $destination = SafePath $root ([string]$entry.path) $true
    $temporaryId = if ($entry.PSObject.Properties['temporaryId']) { [string]$entry.temporaryId } else { '' }
    if ($temporaryId) {
      if ($temporaryId -notmatch '^[a-f0-9]{32}$') { throw 'Invalid journal temporary ID.' }
      $temporary = $destination + '.dubline-update-' + $temporaryId + '.new'
      if (Test-Path -LiteralPath $temporary) {
        if ((Get-Item -LiteralPath $temporary -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe recovery temporary path.' }
        [IO.File]::Delete($temporary)
      }
    }
    if ($entry.existed) {
      $saved = SafePath $backup ([string]$entry.path) $true
      if ((Hash $saved) -ne $entry.oldHash) { throw 'Recovery backup is damaged.' }
      # A failed replacement may have journaled an unchanged original (e.g. a
      # file held open by antivirus). Restoring it again would fail needlessly.
      if (![IO.File]::Exists($destination) -or (Hash $destination) -ne $entry.oldHash) { ReplaceFile $saved $destination $temporaryId }
      if ((Hash $destination) -ne $entry.oldHash) { throw 'Recovery could not be verified.' }
    } elseif (Test-Path -LiteralPath $destination) { [IO.File]::Delete($destination) }
  }
  $journal.phase = 'rolledBack'; WriteAtomic $journalPath ($journal | ConvertTo-Json -Depth 30)
}
function CleanupBackup($journal) {
  $backup = [IO.Path]::GetFullPath([string]$journal.backup)
  if (!$backup.StartsWith($root + '\.dubline-update-backup-', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe backup cleanup.' }
  # Remove only the exact files written by this transaction. Unknown contents stay.
  foreach ($entry in $journal.entries) {
    if (!$entry.existed) { continue }
    $file = SafePath $backup ([string]$entry.path) $true
    if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) }
    $parent = [IO.Path]::GetDirectoryName($file)
    while ($parent.StartsWith($backup + '\', [StringComparison]::OrdinalIgnoreCase)) {
      try { [IO.Directory]::Delete($parent, $false) } catch { break }
      $parent = [IO.Path]::GetDirectoryName($parent)
    }
  }
  try { [IO.Directory]::Delete($backup, $false) } catch { }
}
function WaitForProcesses {
  foreach ($reference in $plan.processes) {
    $process = Get-Process -Id ([int]$reference.id) -ErrorAction SilentlyContinue
    if (!$process) { continue }
    $startTime = $process.StartTime
    if (!$startTime) { if ($process.HasExited) { continue }; throw 'Could not identify an active Dubline process.' }
    $start = $startTime.ToUniversalTime().Ticks
    if ($reference.PSObject.Properties['createdAt'] -and [long]$reference.createdAt -ne [long][Math]::Floor(($start - 621355968000000000) / 10000)) { continue }
    if ($reference.PSObject.Properties['startTicks'] -and [string]$reference.startTicks -ne [string]$start) { continue }
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
      Start-Sleep -Milliseconds 200
      $current = Get-Process -Id ([int]$reference.id) -ErrorAction SilentlyContinue
      if (!$current -or $current.HasExited) { break }
      $currentStart = $current.StartTime
      if (!$currentStart) { if ($current.HasExited) { break }; throw 'Could not identify an active Dubline process.' }
      if ($currentStart.ToUniversalTime().Ticks -ne $start) { break }
      if ([DateTime]::UtcNow -gt $deadline) { throw 'Dubline has not exited; update was not applied.' }
    } while ($true)
  }
}
$lock = $null; $journal = $null; $safeRestart = $false
try {
  if ($plan.schemaVersion -ne 1 -or !$plan.processes -or $root -eq $stage -or $stage.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid update job.' }
  WriteAtomic (Join-Path ([IO.Path]::GetDirectoryName($JobFile)) 'helper-ready.json') '{"ready":true}'
  $baseMap = ValidateManifest $plan.base; $targetMap = ValidateManifest $plan.target
  if ([version]$plan.target.version -le [version]$plan.base.version) { throw 'Portable update must not downgrade.' }
  WaitForProcesses
  $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  if (Test-Path -LiteralPath $journalPath) {
    $previous = Get-Content -LiteralPath $journalPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($previous.phase -ne 'committed' -and $previous.phase -ne 'rolledBack') { Rollback $previous }
  }
  $baseManifest = SafePath $root 'resources/dubline-managed.json' $true
  $targetManifest = SafePath $stage 'resources/dubline-managed.json' $true
  if ((Hash $baseManifest) -ne $plan.baseManifestHash -or (Hash $targetManifest) -ne $plan.targetManifestHash) { throw 'Base or staged manifest changed.' }
  if (!$plan.full) { VerifyFiles $root $plan.base.files }
  $expectedChanged = @($plan.target.files | Where-Object { $plan.full -or !$baseMap.ContainsKey($_.path) -or $baseMap[$_.path].sha256 -ne $_.sha256 -or $baseMap[$_.path].size -ne $_.size } | ForEach-Object { $_.path })
  $expectedRemoved = @($plan.base.files | Where-Object { !$targetMap.ContainsKey($_.path) } | ForEach-Object { $_.path })
  if (($expectedChanged -join "`n") -cne (@($plan.changed) -join "`n") -or ($expectedRemoved -join "`n") -cne (@($plan.removed) -join "`n")) { throw 'Job changes exceed the managed manifests.' }
  VerifyFiles $stage @($plan.target.files | Where-Object { $expectedChanged -ccontains $_.path })
  $backup = Join-Path $root ('.dubline-update-backup-' + [guid]::NewGuid().ToString('N'))
  $null = [IO.Directory]::CreateDirectory($backup)
  $journal = @{ schemaVersion = 1; root = $root; backup = $backup; phase = 'applying'; entries = @(); baseManifestHash = $plan.baseManifestHash; jobFile = [IO.Path]::GetFullPath($JobFile) }
  WriteAtomic $journalPath ($journal | ConvertTo-Json -Depth 30)
  $operations = @($expectedChanged) + @($expectedRemoved) + @('resources/dubline-managed.json')
  foreach ($relative in $operations) {
    $destination = SafePath $root $relative $true
    $existed = Test-Path -LiteralPath $destination -PathType Leaf
    if ($existed -and $relative -ne 'resources/dubline-managed.json' -and !$baseMap.ContainsKey($relative)) { throw 'A new managed path is occupied by an unknown user file.' }
    $oldHash = ''
    if ($existed) {
      $oldHash = Hash $destination; $saved = SafePath $backup $relative $true
      $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($saved))
      [IO.File]::Copy($destination, $saved, $false)
      if ((Hash $saved) -ne $oldHash) { throw 'Backup integrity mismatch.' }
    }
    $temporaryId = [guid]::NewGuid().ToString('N')
    $journal.entries += @{ path = $relative; existed = $existed; oldHash = $oldHash; temporaryId = $temporaryId }
    WriteAtomic $journalPath ($journal | ConvertTo-Json -Depth 30)
    if ($expectedRemoved -ccontains $relative) { if ($existed) { [IO.File]::Delete($destination) } }
    else { ReplaceFile (SafePath $stage $relative $true) $destination $temporaryId }
  }
  VerifyFiles $root $plan.target.files
  if ((Hash $baseManifest) -ne $plan.targetManifestHash) { throw 'Installed target manifest mismatch.' }
  $journal.phase = 'committed'; WriteAtomic $journalPath ($journal | ConvertTo-Json -Depth 30)
  $safeRestart = $true
  $resultPayload = '{"ok":true,"state":"committed"}'
  try { CleanupBackup $journal } catch { }
} catch {
  $message = $_.Exception.Message
  $failedAt = $_.InvocationInfo.ScriptLineNumber
  $recovered = $false
  if ($journal) {
    try { Rollback $journal; VerifyFiles $root $plan.base.files; $recovered = $true; $safeRestart = $true } catch { $message += ' Recovery could not be verified. Download the full Portable ZIP and replace application files; preserve your projects and profile.' }
  }
  $resultPayload = (@{ ok = $false; recovered = $recovered; error = $message; helperLine = $failedAt } | ConvertTo-Json -Depth 5)
} finally {
  if ($lock) { $lock.Dispose() }
  # Completion means a new instance can acquire the application lock. In a full
  # update, backup cleanup can outlive commit; do not publish success before it.
  if ($resultPayload) { WriteAtomic $logPath $resultPayload }
}
if ($safeRestart -and $plan.restart) {
  Start-Process -FilePath (SafePath $root 'Dubline.exe') -WorkingDirectory $root -WindowStyle Hidden
}
