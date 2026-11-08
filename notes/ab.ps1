# Restart the DM with a given spec config, wait for healthy, run the acceptance probe.
# Usage:  .\ab.ps1 -SpecType none
#         .\ab.ps1 -SpecType draft-mtp -DraftNMax 2
#         .\ab.ps1 -SpecType 'draft-mtp,ngram-mod' -DraftNMax 3
param(
    [string]$SpecType = 'draft-mtp',
    [int]$DraftNMax = 3,
    [double]$DraftPMin = 0.15,
    [string]$Label = 'x'
)
$ErrorActionPreference = 'Stop'
Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$argv = @('-m', 'C:\dm\models\Hermes3.6-35B-A3B-Uncensored-Genesis-MTP-MXFP4.gguf',
          '--chat-template-file', 'C:\dm\models\chat_template.jinja', '--jinja',
          '--reasoning', 'off', '--no-reasoning-preserve',
          '-c', '32768', '-np', '1',
          '--cache-type-k', 'f16', '--cache-type-v', 'f16', '--cache-reuse', '8192', '-fa', 'on',
          '--spec-type', $SpecType, '--spec-draft-n-max', "$DraftNMax", '--spec-draft-p-min', "$DraftPMin",
          '-t', '14', '--cpu-strict', '1', '-v',
          '--no-webui', '--host', '127.0.0.1', '--port', '8080')

$log = "C:\dm\logs\ab-$Label.log"
Start-Process -FilePath 'C:\dm\bin\llama\llama-server.exe' -ArgumentList $argv -WindowStyle Hidden `
    -RedirectStandardError $log -RedirectStandardOutput "C:\dm\logs\ab-$Label.out"

for ($i = 0; $i -lt 240; $i++) {
    Start-Sleep -Seconds 1
    if ((& curl.exe -s --noproxy '*' -m 2 'http://127.0.0.1:8080/health') -match 'ok') { break }
}
Write-Host "spec=$SpecType n=$DraftNMax healthy after ${i}s"
python -X utf8 'C:\Users\jommy\Documents\Dungeon-Blaster\notes\probe_mtp.py' 2>&1 | Select-String -NotMatch 'reading the table|accept =|Sparse-MoE|Prose at|nothing for'
