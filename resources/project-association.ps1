param([ValidateSet('status','register','unregister')][string]$Operation,
  [Parameter(Mandatory=$true)][string]$ExePath,
  [Parameter(Mandatory=$true)][string]$ProgID)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if ($ProgID -notmatch '^io\.github\.dmbai009\.Dubline\.Portable\.[a-f0-9]{24}\.Project$' -or ![IO.Path]::IsPathRooted($ExePath) -or $ExePath.Contains('"')) { throw 'Invalid association owner.' }
$exe = [IO.Path]::GetFullPath($ExePath)
$classes = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes')
$owned = $classes.OpenSubKey($ProgID)
$registered = $owned -and $owned.GetValue('DublineOwner', '') -ceq $exe
if ($owned) { $owned.Dispose() }
$userChoice = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.dubline\UserChoice')
$protectedDefault = if ($userChoice) { [string]$userChoice.GetValue('ProgId', '') } else { '' }
if ($userChoice) { $userChoice.Dispose() }
$extension = $classes.OpenSubKey('.dubline')
$classDefault = if ($extension) { [string]$extension.GetValue('', '') } else { '' }
if ($extension) { $extension.Dispose() }
$defaultID = if ($protectedDefault) { $protectedDefault } else { $classDefault }
$staleOwned = $false
if ($defaultID -match '^io\.github\.dmbai009\.Dubline\.Portable\.[a-f0-9]{24}\.Project$') {
  $previous = $classes.OpenSubKey($defaultID)
  if ($previous) {
    try {
      $previousExe = [string]$previous.GetValue('DublineOwner', '')
      $staleOwned = [IO.Path]::IsPathRooted($previousExe) -and !(Test-Path -LiteralPath $previousExe -PathType Leaf)
    } finally { $previous.Dispose() }
  }
}
if ($Operation -eq 'register') {
  if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Dubline executable is missing.' }
  $key = $classes.CreateSubKey($ProgID)
  try { $key.SetValue('', 'Dubline Project'); $key.SetValue('DublineOwner', $exe) } finally { $key.Dispose() }
  $key = $classes.CreateSubKey($ProgID + '\DefaultIcon')
  try { $key.SetValue('', '"' + $exe + '",0') } finally { $key.Dispose() }
  $key = $classes.CreateSubKey($ProgID + '\shell\open\command')
  try { $key.SetValue('', '"' + $exe + '" "%1"') } finally { $key.Dispose() }
  $key = $classes.CreateSubKey('.dubline\OpenWithProgids')
  try { $key.SetValue($ProgID, '') } finally { $key.Dispose() }
  # Open with is sufficient when Windows or another application already owns the default.
  $global = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey('.dubline')
  $globalDefault = if ($global) { [string]$global.GetValue('', '') } else { '' }
  if ($global) { $global.Dispose() }
  if (!$protectedDefault -and ((!$classDefault -and !$globalDefault) -or $staleOwned)) {
    $key = $classes.CreateSubKey('.dubline')
    try { $key.SetValue('', $ProgID) } finally { $key.Dispose() }
    $classDefault = $ProgID
    $staleOwned = $false
  }
  $registered = $true
} elseif ($Operation -eq 'unregister' -and $registered) {
  $classes.DeleteSubKeyTree($ProgID, $false)
  $key = $classes.OpenSubKey('.dubline\OpenWithProgids', $true)
  if ($key) { try { $key.DeleteValue($ProgID, $false) } finally { $key.Dispose() } }
  if ($classDefault -ceq $ProgID) {
    $key = $classes.OpenSubKey('.dubline', $true)
    if ($key) { try { $key.DeleteValue('', $false) } finally { $key.Dispose() } }
    $classDefault = ''
  }
  $registered = $false
}
$classes.Dispose()
if ($Operation -ne 'status') {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class DublineAssociationNotify { [DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, int f, IntPtr a, IntPtr b); }'
  [DublineAssociationNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
}
@{ registered = [bool]$registered; staleOwned = [bool]$staleOwned; defaultOwned = ($protectedDefault -ceq $ProgID -or (!$protectedDefault -and $classDefault -ceq $ProgID)); protectedDefault = [bool]$protectedDefault } | ConvertTo-Json -Compress
