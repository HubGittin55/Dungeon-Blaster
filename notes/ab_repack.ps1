# A/B the MXFP4 repack path: same requests, same threads, only --repack differs.
# Repack converts MXFP4 (block_q8_4x4) into a GEMV-friendly layout at load time. It costs a private
# copy of the weights, which on a 32 GB box is the difference between 21 GiB and 26 GiB of RSS.
# Usage: .\ab_repack.ps1          (runs both arms)
#        .\ab_repack.ps1 -Repack $false
param([nullable[bool]]$Repack = $null)
$ErrorActionPreference = 'Stop'
$Exe = 'C:\dm\bin\llama\llama-server.exe'
$Model = 'C:\dm\models\Hermes3.6-35B-A3B-Uncensored-Genesis-MTP-MXFP4.gguf'

function Common([string[]]$Extra, [string]$Tag) {
    Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep 2
    $argv = @('-m', $Model,
              '--chat-template-file', 'C:\dm\models\chat_template.jinja', '--jinja',
              '--reasoning', 'off', '--no-reasoning-preserve',
              '-c', '32768', '-np', '1', '--cache-type-k', 'f16', '--cache-type-v', 'f16',
              '--cache-reuse', '8192', '-fa', 'on', '--spec-type', 'none',
              '-t', '14', '--cpu-strict', '1',
              '--no-webui', '--host', '127.0.0.1', '--port', '8080') + $Extra
    $t0 = Get-Date
    Start-Process -FilePath $Exe -ArgumentList $argv -WindowStyle Hidden `
        -RedirectStandardError "C:\dm\logs\$Tag.log" -RedirectStandardOutput "C:\dm\logs\$Tag.out"
    for ($i = 0; $i -lt 600; $i++) {
        Start-Sleep -Seconds 1
        if ((& curl.exe -s --noproxy '*' -m 2 'http://127.0.0.1:8080/health') -match 'ok') { break }
    }
    $load = ((Get-Date) - $t0).TotalSeconds
    $p = Get-Process llama-server
    Write-Host ("[{0}] healthy in {1:N0}s   RSS {2:N2} GiB   private {3:N2} GiB" -f `
        $Tag, $load, ($p.WorkingSet64/1GB), ($p.PrivateMemorySize64/1GB))
    # four identical long generations; report best-of (page cache warm by run 2)
    $best = 0.0; $tot = 0; $wall = 0.0
    foreach ($n in 1..4) {
        $body = @{ messages = @(@{ role = 'user'; content = 'Describe in four detailed paragraphs a drowned tomb, a goblin king, and the smell of the water.' })
                   max_tokens = 160; temperature = 0.35; seed = 42 } | ConvertTo-Json -Compress
        Set-Content C:\dm\bench\_r.json $body -Encoding utf8 -NoNewline
        $s = Get-Date
        $r = & curl.exe -s --noproxy '*' -H 'Content-Type: application/json' --data-binary '@C:\dm\bench\_r.json' 'http://127.0.0.1:8080/v1/chat/completions' | ConvertFrom-Json
        $dt = ((Get-Date) - $s).TotalSeconds
        $tok = $r.usage.completion_tokens
        $tps = $tok / $dt
        if ($tps -gt $best) { $best = $tps }
        $tot += $tok; $wall += $dt
        Write-Host ("    run {0}: {1} tok in {2:N1}s = {3:N2} tok/s" -f $n, $tok, $dt, $tps)
    }
    $os = Get-CimInstance Win32_OperatingSystem
    Write-Host ("[{0}] best {1:N2} tok/s | aggregate {2:N2} tok/s | free RAM {3:N1} GiB" -f `
        $Tag, $best, ($tot/$wall), ($os.FreePhysicalMemory/1MB))
    Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep 2
}

if ($Repack -eq $null) {
    Common @() 'repack-on'
    Common @('--no-repack') 'repack-off'
    Write-Host @"

  Read it as: repack buys X tok/s and costs Y GiB of private RAM. The doc's 15-21 tok/s band was
  computed on quants where this trade does not exist; on MXFP4 with 32 GB the choice is forced, and
  whichever arm still leaves headroom for the client plus ComfyUI is the one that ships.
"@
} else {
    if ($Repack) { Common @() 'repack-on' } else { Common @('--no-repack') 'repack-off' }
}
