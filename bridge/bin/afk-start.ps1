<#
  Start (or restart) the AFK loop detached.

  The child must have ALL THREE std handles redirected. Redirecting only stdout/stderr still leaves stdin
  inherited from whoever launched us, which keeps the caller's pipe open forever - I lost a four-minute shell
  timeout to exactly that. -WindowStyle Hidden is not "detached".
#>
param([switch]$Restart, [int]$IntervalSec = 45)
$Root = Split-Path -Parent $PSScriptRoot
$J = Join-Path $Root 'journal'
$pidf = Join-Path $J 'afk.pid'

if (Test-Path $pidf) {
  $old = Get-Content $pidf -EA 0
  if ($old -and (Get-Process -Id $old -EA 0)) {
    if (-not $Restart) { Write-Output "already running: pid $old"; exit 0 }
    & taskkill.exe /T /F /PID $old 2>&1 | Out-Null
    Start-Sleep -Seconds 2
  }
}
$stdin = Join-Path $env:TEMP ("afk-stdin-{0}.null" -f (Get-Random))
Set-Content -Path $stdin -Value '' -NoNewline
$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'afk.ps1'), 'run', '-IntervalSec', "$IntervalSec") `
  -WindowStyle Hidden -WorkingDirectory $Root `
  -RedirectStandardInput $stdin -RedirectStandardOutput (Join-Path $J 'afk-console.log') -RedirectStandardError (Join-Path $J 'afk-console.err') -PassThru
$p.Id | Set-Content $pidf
Write-Output "started: pid $($p.Id) interval ${IntervalSec}s"
