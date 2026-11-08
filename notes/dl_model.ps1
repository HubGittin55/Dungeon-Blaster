# Download the pinned DM weights with resume + retries. Idempotent; safe to re-run.
$ErrorActionPreference = 'Stop'
$repo = 'LuffyTheFox/Qwen3.6-35B-A3B-Uncensored-Genesis-Hermes-MTP-GGUF'
$sha  = 'bb703f2087f43f2f706e3da86577ea3b3b42da42'   # commit, not blob sha - pin is what makes the review reproducible
$file = 'Hermes3.6-35B-A3B-Uncensored-Genesis-MTP-MXFP4.gguf'
$want = 21543974336                                  # measured size from HF X-Linked-Size
$oid  = 'f167e7d2c6661e01f3a57821aa8a411b51c94e28c7324ef566376c3e54daea74'  # LFS sha256

New-Item -ItemType Directory -Force -Path 'C:\dm\models','C:\dm\logs' | Out-Null
$dest = "C:\dm\models\$file"
$url  = "https://huggingface.co/$repo/resolve/$sha/$file"

if ((Test-Path $dest) -and ((Get-Item $dest).Length -eq $want)) { Write-Host "already complete: $dest"; exit 0 }

Write-Host "resumable download -> $dest"
& curl.exe -L --fail --retry 200 --retry-all-errors --retry-delay 3 -C - -o $dest --url $url
$got = (Get-Item $dest).Length
Write-Host ("bytes {0} / {1}  ({2:N1}%)" -f $got, $want, (100.0 * $got / $want))
if ($got -ne $want) { throw "incomplete download" }

Write-Host 'verifying LFS sha256 ...'
$hash = (Get-FileHash -Algorithm SHA256 $dest).Hash.ToLower()
Write-Host "  $hash"
if ($hash -ne $oid) { throw "sha256 mismatch: got $hash want $oid" }
Write-Host 'VERIFIED'
