param([string]$File, [string]$Ready, [string]$Release)
$ErrorActionPreference = 'Stop'
$stream = [IO.File]::Open($File, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  [IO.File]::WriteAllText($Ready, 'ready')
  $deadline = [DateTime]::UtcNow.AddMinutes(3)
  while (!(Test-Path -LiteralPath $Release) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
} finally { $stream.Dispose() }
