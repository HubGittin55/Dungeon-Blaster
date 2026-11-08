# Dungeon Blaster - DM model bench, native Windows (no bash, no Invoke-WebRequest)
#
#   .\bench_dm.ps1 A   build/backend + plain decode tok/s  (the number the architecture doc lacks)
#   .\bench_dm.ps1 B   MTP on: real tok/s + acceptance length  (the MTP go/no-go)
#   .\bench_dm.ps1 C   MTP ceiling via synthetic acceptance  (head quality vs bandwidth)
#   .\bench_dm.ps1 D   TTFT warm vs cold 12K/20K  (does prefix cache survive 30 DeltaNet layers?)
#   .\bench_dm.ps1 E   resolve_round: forced key order + parse rate  (the turn contract)
#   .\bench_dm.ps1 F   RAM / VRAM / pagefile reality
#   .\bench_dm.ps1 G   model load time with and without the Defender exclusion
#
# NOTE on HTTP: everything here goes through curl.exe, not Invoke-RestMethod. Windows PowerShell's
# *Rest* cmdlets consult the system proxy (WPAD) by default and can stall tens of seconds on a
# localhost call; curl with --noproxy removes a whole class of "the DM is hanging" false positives.
param([Parameter(Position=0)][string[]]$Probe = @('A'),
      # Which artifact to bench. The shipping file by default; point it at the DIY requant or the
      # IQ4_XS probe file to A/B them under identical flags and an identical prompt.
      [string]$ModelFile = '',
      [string]$TemplateFile = 'C:\dm\models\chat_template.jinja')

$ErrorActionPreference = 'Stop'
$Root     = 'C:\dm'
$LlamaDir = "$Root\bin\llama"
$Model    = if ($ModelFile) { $ModelFile } else { "$Root\models\Hermes3.6-35B-A3B-Uncensored-Genesis-MTP-MXFP4.gguf" }
$Template = $TemplateFile                            # vendored; the GGUF-embedded one is stock Qwen3.6
$Port     = 8080
$Ctx      = 32768
$Threads  = 14                                       # also try 8 (= physical cores) in probe A
$LogDir   = "$Root\bench";  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Base     = "http://127.0.0.1:$Port"

$BaseArgs = @('-m', $Model, '--chat-template-file', $Template, '--jinja',
              '--reasoning', 'off', '--no-reasoning-preserve',
              '-c', "$Ctx", '-np', '1',
              '--cache-type-k', 'f16', '--cache-type-v', 'f16', '--cache-reuse', '8192',
              '-fa', 'on', '-t', "$Threads", '--cpu-strict', '1',
              '--no-webui', '--host', '127.0.0.1', '--port', "$Port")

function Say([string]$m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function CurlJson([string]$Body) {
    $tmp = New-TemporaryFile
    Set-Content -Path $tmp -Value $Body -Encoding utf8 -NoNewline
    & curl.exe -sS --noproxy '*' -H 'Content-Type: application/json' --data-binary "@$tmp" "$Base/v1/chat/completions"
    Remove-Item $tmp
}
function Start-Srv([string[]]$Extra, [string]$Tag) {
    $p = Start-Process -FilePath "$LlamaDir\llama-server.exe" -ArgumentList ($BaseArgs + $Extra) `
         -PassThru -WindowStyle Hidden `
         -RedirectStandardError "$LogDir\$Tag.log" -RedirectStandardOutput "$LogDir\$Tag.out"
    Write-Host "server pid $($p.Id), stderr -> $LogDir\$Tag.log"
    for ($i = 0; $i -lt 600; $i++) {
        Start-Sleep -Seconds 1
        $r = & curl.exe -s --noproxy '*' -m 2 "$Base/health" 2>$null
        if ($r -match 'ok') { Write-Host "ready after ${i}s"; return $p }
    }
    throw "server not healthy in 10 min; see $LogDir\$Tag.log"
}
function Stop-Srv($p) { if ($p) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; Start-Sleep 2 } }

switch ($Probe) {

'A' {
    Say 'A. backend + SIMD paths actually loaded'
    $p = Start-Srv @('--spec-type','none') 'A-plain'
    Get-Content "$LogDir\A-plain.log" | Select-String -Pattern 'system info|load_backend|AVX|REPACK|VNNI|OPENMP|n_threads|flash|MTP|nextn|spec' |
        Select-Object -First 20
    Stop-Srv $p
    Say 'A2. plain decode - the bandwidth-bound reference (measured 15.5 tok/s for this file at 2.50 GiB/token)'
    Write-Host '  try both thread counts; more threads can LOSE on a memory-bound MoE:'
    & "$LlamaDir\llama-bench.exe" -m $Model -ngl 0 -p 512,2048 -n 128,512 -r 3 -t 8,14
    Write-Host @"

  Convert the winner back to bandwidth: tok/s x GiB/token (notes/gguf_tokens.py) = GB/s needed.
  This box measures 38-39 GB/s on two independent artifacts, so that is the wall.
  If measured GB/s is far under 38, something else is binding: power plan not on Performance, threads
  wrong for a memory-bound MoE (try -t 8 = physical cores), or the quant's dequant path is compute-bound.
"@
}

'B' {
    Say 'B. MTP on - real acceptance length'
    $p = Start-Srv @('--spec-type','draft-mtp','--spec-draft-n-max','3','--spec-draft-p-min','0.15','-v') 'B-mtp'
    foreach ($t in @('Narrate in two sentences: the party pries open a tomb door and finds a very small, very annoyed goblin.',
                     '{"narration":"The smith hammers the ingot flat.","mutations":[{"id":"m1","tool":"spend","actor":2,"intent":"craft a short sword","args":{"iron":2}}]}',
                     'A merchant offers three items: a wolf-pelt cloak, a chipped warhammer, a vial of grave dirt. Describe each in one clause.')) {
        $body = @{ messages = @(@{ role = 'user'; content = $t }); max_tokens = 120; temperature = 0.75 } | ConvertTo-Json -Compress
        $r = (CurlJson $body) | ConvertFrom-Json
        Write-Host ("  in={0} out={1} tok/s={2}" -f $r.usage.prompt_tokens, $r.usage.completion_tokens,
                    ('{0:N1}' -f ($r.usage.completion_tokens / [Math]::Max($r.timings_per_token_s, 0.001))))
    }
    Stop-Srv $p
    Say 'B2. acceptance out of the server log (THE number for the MTP decision)'
    Get-Content "$LogDir\B-mtp.log" | Select-String -Pattern 'spec|accept|draft|nextn' | Select-Object -Last 40
    Write-Host @"

  Sparse-MoE rule: 8-of-256 routing means verified tokens barely share experts (fan-out x3.8 at
  n-max 3), so MTP pays only at high acceptance. Judge per phase, not per round:
    L >= 2.6 on the resolve_round/JSON phase  -> keep MTP; that is the phase the gate waits on.
    L <= 1.6 everywhere, or slower than none  -> drop the 898 MB head, ship the non-MTP file.
  The head was transplanted from a different quant of the UNREPAIRED base model, so below-official
  acceptance is the expected case, not a bug to chase.
"@
}

'C' {
    Say 'C. synthetic acceptance = the MTP ceiling on this box, independent of head quality'
    Write-Host ('  cmd: llama-server.exe ' + (($BaseArgs + @('--spec-type','draft-mtp','--spec-draft-n-max','3','--spec-synth-len','3.0','-v')) -join ' '))
    Write-Host '  ceiling/plain = max possible MTP gain (predicted 1.5-2.0x);  real/plain = what we get (1.1-1.4x on prose).'
    Write-Host '  If the ceiling is ~1.0x, MTP is dead here for any head and decode is not the binding constraint.'
}

'D' {
    Say 'D. TTFT warm vs cold at 12K and 20K (hybrid DeltaNet prefix reuse)'
    $p = Start-Srv @('--spec-type','none') 'D-ttft'
    $pre = 'You are the Dungeon Master of Dungeon Blaster. ' + ('Tier tables: T1 wood iron cloth bone; T2 steel hardwood leather silver; T3 mithral rare hides; T4 monster-derived; T5 unique quest-bound. ' * 200)
    foreach ($target in 12000, 20000) {
        $sys = $pre.Substring(0, [Math]::Min($target, $pre.Length))
        foreach ($pair in @(@('cold', "New location $([guid]::NewGuid()): "), @('warm', 'Same location, next round: '))) {
            $body = @{ messages = @(@{ role = 'system'; content = $sys },
                                    @{ role = 'user'; content = ($pair[1] + 'Two sentences of narration please.') })
                      max_tokens = 24; stream = $true; temperature = 0.0; cache_prompt = $true } | ConvertTo-Json -Compress
            $tmp = New-TemporaryFile; Set-Content $tmp $body -Encoding utf8 -NoNewline
            $sw = [Diagnostics.Stopwatch]::StartNew(); $ttft = -1
            & curl.exe -sN --noproxy '*' -H 'Content-Type: application/json' --data-binary "@$tmp" "$Base/v1/chat/completions" |
                ForEach-Object {
                    if ($ttft -lt 0 -and $_ -match '"content":\s*"([^\\]|\\"|\\[^"])*[A-Za-z]') { $ttft = $sw.Elapsed.TotalSeconds }
                }
            Remove-Item $tmp
            Write-Host ('  {0,6} tok prompt  {1,-5}  ttft={2:N2}s' -f $target, $pair[0], $ttft)
        }
    }
    Stop-Srv $p
    Write-Host @"

  warm must be far under cold. If it is not, prefix reuse across the 30 DeltaNet layers is not
  happening and the 32K budget must be re-derived around cold prefill - the biggest unknown in the
  project. Try in order: -np 1, --cache-reuse 8192 (already on), GET /props between requests, then
  pin a build and bisect.
"@
}

'E' {
    Say 'E. resolve_round via json_schema: key order, parseability, streaming shape'
    $schemaPath = "$Root\resolve_round.schema.json"
    if (-not (Test-Path $schemaPath)) { throw "missing $schemaPath (see notes/resolve_round.schema.json)" }
    $p = Start-Srv @('--spec-type','none') 'E-contract'
    $pass = 0; $order = 0
    1..20 | ForEach-Object {
        $n = $_
        $body = @{ messages = @(@{ role = 'user'
                    content = "Slot $((($_-1)%4)+1) spends 2 iron (tier 1) to craft a short sword. One sentence of narration." })
                  max_tokens = 200; temperature = 0.2; seed = $_
                  response_format = @{ type = 'json_schema'; json_schema = @{ name = 'resolve_round'; schema = (Get-Content $schemaPath -Raw | ConvertFrom-Json) } } } | ConvertTo-Json -Depth 20 -Compress
        $r = (CurlJson $body) | ConvertFrom-Json
        $c = $r.choices[0].message.content
        try { $o = $c | ConvertFrom-Json
              $pass++
              # narration must come FIRST: it is what the players are waiting to hear, and TTS can only speak what has
                    # already streamed. A regression here costs 3-7s of dead air per round.
                    if ($c.IndexOf('"narration"') -lt $c.IndexOf('"mutations"')) { $order++ } }
        catch { Write-Host "  #$_ parse FAIL: $($c.Substring(0,[Math]::Min(160,$c.Length)))" }
    }
    Stop-Srv $p
    Write-Host ("  JSON parse: $pass/20    narration-before-mutations: $order/20")
    Write-Host '  The streamed gate requires 20/20 on both. Anything less and the contract is two-pass.'
}

'F' {
    Say 'F. RAM / VRAM / pagefile'
    $os = Get-CimInstance Win32_OperatingSystem
    Write-Host ('  RAM total {0:N1} GiB, free {1:N1} GiB' -f ($os.TotalVisibleMemorySize/1MB), ($os.FreePhysicalMemory/1MB))
    Get-CimInstance Win32_PageFileUsage | ForEach-Object { Write-Host "  pagefile $($_.Name) alloc $($_.AllocatedBaseSize) MB peak $($_.PeakUsage) MB" }
    Get-CimInstance Win32_VideoController | ForEach-Object { Write-Host ("  GPU {0}: {1:N1} GiB (WMI AdapterRAM caps at 4 GiB - trust nvidia-smi instead)" -f $_.Name, ($_.AdapterRAM/1GB)) }
    & nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used --format=csv
    Get-Process -Name llama-server, audiocpp_server, python, node -ErrorAction SilentlyContinue |
        Select-Object Name, @{n='RSS_GiB';e={'{0:N2}' -f ($_.WorkingSet64/1GB)}}, @{n='Commit_GiB';e={'{0:N2}' -f ($_.PrivateMemorySize64/1GB)}} | Format-Table -AutoSize
    Write-Host '  predicted: 20.06 weights + 0.63 KV@32K + ~0.6 compute/MTP + 1.1 audio + client  ->  re-run with everything loaded'
}

'G' {
    Say 'G. model load time, Defender on then off (20 GiB mmap is not free)'
    Write-Host '  run as admin between attempts: Add-MpPreference -ExclusionPath "C:\dm\models","C:\dm\assets","C:\dm\db"'
    1..2 | ForEach-Object {
        $t = Measure-Command {
            $p = Start-Process -FilePath "$LlamaDir\llama-server.exe" -ArgumentList ($BaseArgs + @('--slots')) -PassThru -WindowStyle Hidden -RedirectStandardError "$LogDir\G$_.log" -RedirectStandardOutput "$LogDir\G$_.out"
            for ($i=0; $i -lt 1200; $i++) { Start-Sleep -Milliseconds 500
                if ((& curl.exe -s --noproxy '*' -m 2 "$Base/health") -match 'ok') { break } }
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
        Write-Host ("  attempt {0}: {1:N1}s to healthy" -f $_, $t.TotalSeconds)
    }
}

default { Write-Host 'usage: .\bench_dm.ps1 A|B|C|D|E|F|G' }
}
