# Start the Dungeon Blaster DM (llama-server, native Windows, CPU-only).
#
# Two knobs are decided by measurement on this box, not by taste - see the numbers in
# notes/model-review-qwen36-hermes-mtp.md section 9:
#   --no-repack : repack is ON by default and converts MXFP4 into a private ~18 GiB copy for a
#                 compute speedup we cannot use (decode is bandwidth-bound). Measured 15.43 vs
#                 15.48 tok/s, RSS 25.5 GiB -> 12.2 GiB, private 18.4 -> 1.6 GiB.
#   -SpecType none : MTP works but acceptance is 0.41-0.56 (mean_len 2.2-2.7), which is a wash or a
#                 small loss on 8-of-256 routing. Pass -SpecType draft-mtp to A/B it again.
param(
    [string]$SpecType = 'none',
    [ValidateRange(0,8)][int]$DraftNMax = 2,        # >2 loses the win on sparse MoE: verified tokens fan out across experts
    [double]$DraftPMin = 0.15,
    [int]$Threads = 14,
    [int]$Ctx = 32768,
    [int]$Port = 8080,
    [switch]$VerboseLogging,
    [switch]$NoThinkingCap                                # cap thinking even if a template re-enables it
)
$ErrorActionPreference = 'Stop'
$Exe     = 'C:\dm\bin\llama\llama-server.exe'
$Model   = 'C:\dm\models\Hermes3.6-35B-A3B-Uncensored-Genesis-MTP-MXFP4.gguf'
$Template= 'C:\dm\models\chat_template.jinja'   # vendored community template, NOT the GGUF-embedded stock one
$Logs    = 'C:\dm\logs'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

# A second llama-server on 20 GiB of weights will not fit; kill the old one instead of failing oddly.
Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$argv = @('-m', $Model,
          '--chat-template-file', $Template, '--jinja',
          '--reasoning', 'off', '--no-reasoning-preserve',
          '-c', "$Ctx", '-np', '1',
          '--cache-type-k', 'f16', '--cache-type-v', 'f16',
          '--cache-reuse', '8192', '-fa', 'on', '--no-repack',
          '--spec-type', $SpecType, '--spec-draft-n-max', "$DraftNMax", '--spec-draft-p-min', "$DraftPMin",
          '-t', "$Threads", '--cpu-strict', '1',
          '--no-webui', '--host', '127.0.0.1', '--port', "$Port")
if ($NoThinkingCap) { $argv += @('--reasoning-budget', '0') }
if ($VerboseLogging) { $argv += '-v' }

$log = Join-Path $Logs ('llama-{0}-n{1}-{2:HHmmss}.log' -f ($SpecType -replace '[=,]','_'), $DraftNMax, (Get-Date))
$p = Start-Process -FilePath $Exe -ArgumentList $argv -PassThru -WindowStyle Hidden `
        -RedirectStandardError $log -RedirectStandardOutput ($log -replace '\.log$','.out')
Write-Host "llama-server pid $($p.Id)  spec=$SpecType n=$DraftNMax t=$Threads  -> $log"

for ($i = 0; $i -lt 600; $i++) {
    Start-Sleep -Seconds 1
    if ((& curl.exe -s --noproxy '*' -m 2 "http://127.0.0.1:$Port/health") -match 'ok') {
        Write-Host "healthy after ${i}s"
        & curl.exe -s --noproxy '*' "http://127.0.0.1:$Port/props" | python -X utf8 -c "
import json,sys
d = sys.stdin.read()
try:
    j = json.loads(d)
    print('  model  :', j.get('build_info','')[:60])
    print('  ctx    :', j.get('n_ctx'), ' slots:', j.get('n_ctx_prompt'))
except Exception:
    print(d[:300])
"
        Write-Host "  log    : $log"
        exit 0
    }
}
Write-Error 'llama-server did not become healthy in 10 min'
Get-Content $log -Tail 30
exit 1
