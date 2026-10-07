param([Parameter(Mandatory=$true)][string]$SetupFile,
  [Parameter(Mandatory=$true)][string]$InstallDirectory,
  [Parameter(Mandatory=$true)][string]$ReportFile,
  [switch]$ProbeOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$qaRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\build\update-qa')) + '\'
$target = [IO.Path]::GetFullPath($InstallDirectory)
$report = [IO.Path]::GetFullPath($ReportFile)
foreach ($ownedPath in @($target, $report)) {
  if (!$ownedPath.StartsWith($qaRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Wizard QA must stay inside the isolated QA directory.' }
}
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DublineWizardWindows {
  public delegate bool Visitor(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor visitor, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, Visitor visitor, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int capacity);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hwnd, int id);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageW")] public static extern IntPtr ReadText(IntPtr hwnd, uint message, IntPtr wparam, StringBuilder text);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageW")] public static extern IntPtr WriteText(IntPtr hwnd, uint message, IntPtr wparam, string text);
  public static string Text(IntPtr hwnd) {
    var value = new StringBuilder(16384);
    ReadText(hwnd, 0x000D, (IntPtr)value.Capacity, value);
    return value.ToString();
  }
  public static string Class(IntPtr hwnd) {
    var value = new StringBuilder(128); GetClassName(hwnd, value, value.Capacity); return value.ToString();
  }
}
'@
$installer = Start-Process -FilePath ([IO.Path]::GetFullPath($SetupFile)) -ArgumentList @('/currentuser') -WindowStyle Hidden -PassThru
$visited = @{ welcome=$false; license=$false; directory=$false; finish=$false; launchUnchecked=$false }
$lastControls = @()
$cancelling = $false
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(150)
  while (!$installer.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    $script:dialog = [IntPtr]::Zero
    [DublineWizardWindows]::EnumWindows({ param($handle, $unused)
      [uint32]$owner = 0
      [void][DublineWizardWindows]::GetWindowThreadProcessId($handle, [ref]$owner)
      if ($owner -eq $installer.Id -and [DublineWizardWindows]::Class($handle) -eq '#32770') { $script:dialog=$handle }
      return $true
    }, [IntPtr]::Zero) | Out-Null
    if ($script:dialog -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100; continue }
    [void][DublineWizardWindows]::ShowWindow($script:dialog, 0)
    if ($cancelling) {
      $confirm=[DublineWizardWindows]::GetDlgItem($script:dialog,6)
      if ($confirm -ne [IntPtr]::Zero) { [void][DublineWizardWindows]::PostMessage($script:dialog,0x0111,[IntPtr]6,$confirm) }
      Start-Sleep -Milliseconds 100; continue
    }
    $script:controls = New-Object 'Collections.Generic.List[object]'
    [DublineWizardWindows]::EnumChildWindows($script:dialog, { param($handle, $unused)
      if (([DublineWizardWindows]::GetWindowLong($handle, -16) -band 0x10000000) -ne 0) {
        $script:controls.Add(@{ handle=$handle; id=[DublineWizardWindows]::GetDlgCtrlID($handle); class=[DublineWizardWindows]::Class($handle); text=[DublineWizardWindows]::Text($handle) })
      }
      return $true
    }, [IntPtr]::Zero) | Out-Null
    $lastControls = @($script:controls | ForEach-Object { @{ id=$_.id; class=$_.class; text=$_.text } })
    $next = $script:controls | Where-Object { $_.id -eq 1 -and $_.class -eq 'Button' } | Select-Object -First 1
    if (!$next -or ![DublineWizardWindows]::IsWindowEnabled($next.handle)) { Start-Sleep -Milliseconds 100; continue }
    $allText = ($script:controls | ForEach-Object { $_.text }) -join "`n"
    $directory = $script:controls | Where-Object { $_.class -eq 'Edit' -and $_.text -match '^[A-Za-z]:\\' } | Select-Object -First 1
    if ($directory) {
      if (!$visited.welcome -or !$visited.license) { throw 'Destination page appeared without welcome/license.' }
      [void][DublineWizardWindows]::WriteText($directory.handle, 0x000C, [IntPtr]::Zero, $target)
      if ([DublineWizardWindows]::Text($directory.handle) -cne $target) { throw 'The destination textbox rejected the selected path.' }
      $visited.directory=$true
      if ($ProbeOnly) {
        $cancelling=$true
        [void][DublineWizardWindows]::PostMessage($script:dialog,0x0111,[IntPtr]2,[DublineWizardWindows]::GetDlgItem($script:dialog,2))
        Start-Sleep -Milliseconds 100; continue
      }
    } elseif ($allText.Contains('DubLine Source License 1.0')) {
      $visited.license=$true
    } elseif ($visited.directory -and (Test-Path -LiteralPath (Join-Path $target 'Dubline.exe'))) {
      $launch = $script:controls | Where-Object { $_.class -eq 'Button' -and ($_.text -match 'Dubline') -and $_.id -ne 1 } | Select-Object -First 1
      if (!$launch) { throw 'Finish page is missing the optional launch checkbox.' }
      [void][DublineWizardWindows]::SendMessage($launch.handle, 0x00F1, [IntPtr]::Zero, [IntPtr]::Zero)
      if ([DublineWizardWindows]::SendMessage($launch.handle, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() -ne 0) { throw 'Could not disable launch after installation.' }
      $visited.finish=$true; $visited.launchUnchecked=$true
    } elseif (!$visited.license) {
      $visited.welcome=$true
    } else { throw 'Unexpected wizard page.' }
    # WM_COMMAND/BN_CLICKED works without activating a hidden native dialog.
    [void][DublineWizardWindows]::PostMessage($script:dialog, 0x0111, [IntPtr]1, $next.handle)
    Start-Sleep -Milliseconds 200
  }
  if (!$installer.HasExited) { throw 'Wizard did not finish within the timeout.' }
  $installer.WaitForExit()
  if ($ProbeOnly) {
    if ($installer.ExitCode -notin @(0,1) -or !$cancelling) { throw "Wizard probe did not cancel safely: exit $($installer.ExitCode), cancel=$cancelling." }
    if (Test-Path -LiteralPath (Join-Path $target 'Dubline.exe')) { throw 'The probe unexpectedly installed application files.' }
    foreach ($step in @('welcome','license','directory')) { if (!$visited[$step]) { throw "Missing probe step: $step" } }
  } else {
    if ($installer.ExitCode -ne 0) { throw "Wizard exited with code $($installer.ExitCode)." }
    foreach ($step in $visited.Keys) { if (!$visited[$step]) { throw "Missing wizard step: $step" } }
    if (!(Test-Path -LiteralPath (Join-Path $target 'Uninstall Dubline.exe'))) { throw 'Uninstaller was not installed in the selected folder.' }
  }
  [IO.File]::WriteAllText($report, (@{ ok=$true; probeOnly=[bool]$ProbeOnly; pages=$visited; directory=$target } | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
} catch {
  [Console]::Error.WriteLine(($lastControls | ConvertTo-Json -Depth 4))
  throw
} finally {
  if (!$installer.HasExited) { Stop-Process -Id $installer.Id -Force }
  $installer.Dispose()
}
