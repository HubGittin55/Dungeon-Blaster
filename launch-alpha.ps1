<#
.SYNOPSIS
    One script, one window, whole game.

.DESCRIPTION
    Starts whatever is not already running - the DM model server, the audio servers, ComfyUI - then the
    game server in THIS window, then opens the couch view in a browser.

    Two rules this file is built around, both of them paid for:

    1. It only ever kills what it started. The two audio.cpp builds ship the same executable name, and a
       restart-by-process-name of the CPU server once took the narrator with it. Services that were
       already up when this script ran are reported and left completely alone.
    2. It never starts a second ComfyUI. One render server is enough and a second one competes for the
       same 8 GB card.

    With -FakeDm nothing GPU-side is started at all: the game plays against a scripted game master that
    still goes through the real gate, so the whole loop is playable on a machine with no model loaded.
    Art renders are skipped in that mode too - nothing about the round needs a picture to be legal.

    Flag meanings and measurements behind them: DEPENDENCIES.md.

.EXAMPLE
    .\launch-alpha.ps1                 # everything, real DM
    .\launch-alpha.ps1 -FakeDm         # instant, no model, no GPU, still gated
    .\launch-alpha.ps1 -NoVoice -NoArt # text and pictures off; play with a keyboard
#>
#requires -Version 5.1
[CmdletBinding()]
param(
    [int]$Port = 8765,
    [switch]$FakeDm,          # scripted DM: no llama-server, no GPU, same gate
    [switch]$NoVoice,         # skip audio.cpp entirely
    [switch]$NoArt,           # skip ComfyUI entirely
    [switch]$NoBrowser,
    [string]$Model   = 'C:\dm\models\Hermes3.6-35B-A3B-MTP-MXFP4exp-Q4K_S.gguf',
    [string]$ChatTemplate = 'C:\dm\models\chat_template.jinja',
    [string]$LlamaServer  = 'C:\dm\bin\llama\llama-server.exe',
    [string]$AudioCpuLauncher = 'C:\dm\start-audio.ps1',
    [string]$AudioGpuLauncher = 'C:\dm\start-audio-gpu.ps1',
    [string]$ComfyPython = 'C:\Users\jommy\OneDrive\Documents\ComfyUI\python_embeded\python.exe',
    [string]$ComfyMain   = 'C:\Users\jommy\OneDrive\Documents\ComfyUI\ComfyUI\main.py',
    [string]$Logs = 'C:\dm\logs'
)

$ErrorActionPreference = 'Stop'
$Repo = $PSScriptRoot
if (-not (Test-Path $Logs)) { New-Item -ItemType Directory -Force -Path $Logs | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$owned = @()   # PIDs this launch created. Nothing else gets stopped.

function Test-Port([int]$p) {
    $c = $null
    try {
        $c = New-Object Net.Sockets.TcpClient
        $ok = $c.ConnectAsync('127.0.0.1', $p).Wait(300)
        return ($ok -and $c.Connected)
    } catch { return $false } finally { if ($c) { $c.Close() } }
}

# curl.exe, not Invoke-WebRequest: on this box IRM honours WPAD and happily routes 127.0.0.1 through a
# proxy that does not exist, so a health check that "should" pass quietly fails.
function Get-Http([string]$url) {
    try { return (& curl.exe -s --noproxy '*' --max-time 4 $url) } catch { return $null }
}

function Wait-Health([string]$url, [int]$seconds, [string]$label) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        $body = Get-Http $url
        if ($body -and ($body -match '"status"\s*:\s*"(ok|ready)"' -or $body -match '"sensors"' -or $body -match 'nvidia')) {
            Write-Host ("  {0,-10} up" -f $label) -ForegroundColor DarkGreen
            return $true
        }
        if ($label -eq 'comfy' -and $body -and $body.Length -gt 20) {
            Write-Host ("  {0,-10} up" -f $label) -ForegroundColor DarkGreen; return $true
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Host ("  {0,-10} NOT answering on {1} after {2}s (log: {3})" -f $label, $url, $seconds, $Logs) -ForegroundColor Yellow
    return $false
}

function Start-Own([string]$label, [string]$exe, [string[]]$args, [string]$workdir = $null) {
    $out = Join-Path $Logs "alpha-$label-$stamp.out.log"
    $err = Join-Path $Logs "alpha-$label-$stamp.err.log"
    $p = Start-Process -FilePath $exe -ArgumentList $args -NoNewWindow -PassThru `
            -RedirectStandardOutput $out -RedirectStandardError $err -RedirectStandardInput 'NUL' `
            -WorkingDirectory $workdir
    Write-Host ("  {0,-10} started (pid {1})" -f $label, $p.Id) -ForegroundColor DarkCyan
    Write-Host ("             log: {0}" -f $out) -ForegroundColor DarkGray
    $script:owned += [pscustomobject]@{ Id = $p.Id; Name = $label }
    return $p
}

$env:DB_GAME_URL = "http://127.0.0.1:$Port"
Write-Host ''
Write-Host '  Dungeon Blaster - alpha' -ForegroundColor Yellow
Write-Host "  repo $Repo" -ForegroundColor DarkGray
Write-Host ''

# ---------------------------------------------------------------- 1. the DM
if ($FakeDm) {
    Write-Host 'dm        skipped (-FakeDm): scripted game master, no model, no GPU' -ForegroundColor DarkGray
} else {
    if (Test-Port 8080) {
        Write-Host 'dm        already running on :8080 - left alone' -ForegroundColor DarkGreen
    } elseif (-not (Test-Path $LlamaServer)) {
        Write-Host "dm        llama-server not found at $LlamaServer" -ForegroundColor Red
        Write-Host '          see DEPENDENCIES.md 4 (and its launch flags). Playing with -FakeDm is one flag away.' -ForegroundColor DarkGray
    } elseif (-not (Test-Path $Model)) {
        Write-Host "dm        model not found: $Model" -ForegroundColor Red
        Write-Host '          DEPENDENCIES.md 4 lists the downloadable quant and its sha256.' -ForegroundColor DarkGray
    } else {
        Write-Host 'dm        starting llama-server (this maps ~18 GiB and takes a while)' -ForegroundColor DarkGray
        # Flag set is not a preference: --no-repack off costs 18 GiB and goes slower, --spec-type none is
        # locked because MTP measured a loss on this card, reasoning off because the budget is first audio.
        $args = @(
            '-m', "`"$Model`"",
            '--chat-template-file', "`"$ChatTemplate`"", '--jinja',
            '--reasoning', 'off', '--no-reasoning-preserve',
            '-c', '32768', '-np', '1', '-t', '14', '-fa', 'on',
            '--cache-type-k', 'f16', '--cache-type-v', 'f16', '--cache-reuse', '8192',
            '--no-repack', '--spec-type', 'none',
            '--spec-draft-n-max', '2', '--spec-draft-p-min', '0.15',
            '--no-webui', '--host', '127.0.0.1', '--port', '8080'
        )
        Start-Own 'dm' $LlamaServer $args | Out-Null
        Wait-Health 'http://127.0.0.1:8080/health' 180 'dm' | Out-Null
    }
}

# --------------------------------------------------------------- 2. voice
if ($NoVoice) {
    Write-Host 'voice     skipped (-NoVoice): narration is silent, talk with the keyboard' -ForegroundColor DarkGray
} else {
    foreach ($svc in @(@{ n = 'audio-cpu'; p = 8081; l = $AudioCpuLauncher }, @{ n = 'audio-gpu'; p = 8082; l = $AudioGpuLauncher })) {
        if (Test-Port $svc.p) {
            Write-Host ("  {0,-10} already running on :{1} - left alone" -f $svc.n, $svc.p) -ForegroundColor DarkGreen
        } elseif (Test-Path $svc.l) {
            # Delegation, not duplication: the audio launchers already know their config files, the
            # eSpeak-ng data path, and how to stop an old instance by install directory.
            Start-Own $svc.n 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($svc.l)`"") | Out-Null
        } else {
            Write-Host ("  {0,-10} launcher absent ($($svc.l)) - DEPENDENCIES.md 5" -f $svc.n) -ForegroundColor Yellow
        }
    }
    Wait-Health 'http://127.0.0.1:8081/health' 90 'asr' | Out-Null
    Wait-Health 'http://127.0.0.1:8082/health' 90 'narrator' | Out-Null
}

# ----------------------------------------------------------------- 3. art
if ($NoArt) {
    Write-Host 'art       skipped (-NoArt): cards arrive as text' -ForegroundColor DarkGray
} elseif (Test-Port 8188) {
    Write-Host 'art       ComfyUI already running on :8188 - left alone (one render server is enough)' -ForegroundColor DarkGreen
} elseif (Test-Path $ComfyPython) {
    Write-Host 'art       starting ComfyUI' -ForegroundColor DarkGray
    # 127.0.0.1, not 0.0.0.0: ComfyUI has no authentication and --listen 0.0.0.0 puts it on the LAN.
    Start-Own 'comfy' $ComfyPython @("`"$ComfyMain`"", '--fast', '--disable-partner-nodes', '--disable-xformers', '--listen', '127.0.0.1') (Split-Path $ComfyMain) | Out-Null
    Wait-Health 'http://127.0.0.1:8188/system_stats' 150 'comfy' | Out-Null
} else {
    Write-Host "art       ComfyUI not found at $ComfyPython - cards stay text (DEPENDENCIES.md 6)" -ForegroundColor Yellow
}

# ----------------------------------------------------------------- 4. node
$node = (Get-Command node.exe -ErrorAction SilentlyContinue)
if (-not $node) { Write-Host "`nnode.exe not on PATH - DEPENDENCIES.md 2" -ForegroundColor Red; exit 1 }

$env:DB_GAME_PORT = "$Port"
if (-not $env:DB_TTS_URL)  { $env:DB_TTS_URL = 'http://127.0.0.1:8082/v1/audio/speech' }
if ($NoVoice)             { $env:DB_TTS_URL = '' }
if (-not $env:DB_DM_URL)  { $env:DB_DM_URL = 'http://127.0.0.1:8080' }

$url = "http://127.0.0.1:$Port"
Write-Host ''
Write-Host "  table     $url" -ForegroundColor Cyan
if (-not $NoBrowser) { Start-Process $url }
Write-Host '  ctrl-c    stops this window and everything this window started' -ForegroundColor DarkGray
Write-Host ''

try {
    # Foreground on purpose: the game server's own log lines are the status readout for this window, and
    # a round that takes 40 seconds should look like work happening rather than a hang.
    if ($FakeDm) { & node.exe (Join-Path $Repo 'game\server.mjs') --fake-dm }
    else { & node.exe (Join-Path $Repo 'game\server.mjs') }
} finally {
    Write-Host ''
    Write-Host '  stopping what this window started' -ForegroundColor DarkGray
    foreach ($o in $owned) {
        Stop-Process -Id $o.Id -Force -ErrorAction SilentlyContinue
        Write-Host ("  {0,-10} stopped (pid {1})" -f $o.Name, $o.Id) -ForegroundColor DarkCyan
    }
    Write-Host '  services that were already running are still running.' -ForegroundColor DarkGray
}
