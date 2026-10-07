param([ValidateSet('preflight','status','foreign','cleanup')][string]$Operation,
  [Parameter(Mandatory=$true)][string]$JobFile)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($job.foreign -notmatch '^io\.github\.dmbai009\.Dubline\.QA\.[a-f0-9]{32}\.Project$') { throw 'Invalid QA owner.' }
$classes = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes')
$setup = 'io.github.dmbai009.Dubline.Setup.Project'
function Values([string]$location) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($location)
  $result = @{}
  if ($key) { try { foreach ($name in $key.GetValueNames()) { $result[$name] = $key.GetValue($name) } } finally { $key.Dispose() } }
  return $result
}
function Snapshot {
  $command = $classes.OpenSubKey($setup + '\shell\open\command')
  $openCommand = if ($command) { [string]$command.GetValue('', '') } else { '' }; if ($command) { $command.Dispose() }
  return @{ extension = (Values 'Software\Classes\.dubline'); openWith = (Values 'Software\Classes\.dubline\OpenWithProgids');
    userChoice = (Values 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.dubline\UserChoice');
    setup = (Values ('Software\Classes\' + $setup)); command = $openCommand }
}
if ($Operation -eq 'preflight') {
  foreach ($location in @([Environment]::GetFolderPath('Desktop'), [IO.Path]::Combine([Environment]::GetFolderPath('StartMenu'), 'Programs'))) {
    if ((Test-Path -LiteralPath (Join-Path $location 'Dubline.lnk')) -or (Test-Path -LiteralPath (Join-Path $location 'Dubline'))) { throw 'Existing Dubline shortcuts would be affected. Use a clean Windows user profile.' }
  }
  if ((Snapshot).setup.Count) { throw 'A Setup handler already exists. Run this QA in a clean Windows user profile.' }
  $uninstall = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
  if ($uninstall) {
    try {
      foreach ($name in $uninstall.GetSubKeyNames()) {
        $entry = $uninstall.OpenSubKey($name)
        try { if ([string]$entry.GetValue('DisplayName', '') -match '(?i)dubline') { throw 'An existing Dubline installation would be affected. Use a clean Windows user profile.' } } finally { $entry.Dispose() }
      }
    } finally { $uninstall.Dispose() }
  }
} elseif ($Operation -eq 'foreign') {
  $key = $classes.CreateSubKey($job.foreign)
  try { $key.SetValue('', 'Dubline QA foreign handler'); $key.SetValue('QAOwner', $JobFile) } finally { $key.Dispose() }
  $key = $classes.CreateSubKey('.dubline\OpenWithProgids')
  try { $key.SetValue($job.foreign, '') } finally { $key.Dispose() }
  # Replace only the newly created QA Setup default. Preserve every preexisting default.
  $key = $classes.CreateSubKey('.dubline')
  try { if (!$job.previousDefault -and [string]$key.GetValue('', '') -ceq $setup) { $key.SetValue('', $job.foreign) } } finally { $key.Dispose() }
} elseif ($Operation -eq 'cleanup') {
  $key = $classes.OpenSubKey($job.foreign)
  $owned = $key -and [string]$key.GetValue('QAOwner', '') -ceq $JobFile
  if ($key) { $key.Dispose() }
  if ($owned) {
    $classes.DeleteSubKeyTree($job.foreign, $false)
    $key = $classes.OpenSubKey('.dubline\OpenWithProgids', $true)
    if ($key) { try { $key.DeleteValue($job.foreign, $false) } finally { $key.Dispose() } }
    $key = $classes.OpenSubKey('.dubline', $true)
    if ($key) { try { if ([string]$key.GetValue('', '') -ceq $job.foreign) { if ($job.previousDefault) { $key.SetValue('', [string]$job.previousDefault) } else { $key.DeleteValue('', $false) } } } finally { $key.Dispose() } }
  }
}
$result = Snapshot
$classes.Dispose()
$result | ConvertTo-Json -Depth 8 -Compress
