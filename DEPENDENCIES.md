# Dependencies

Getting Dungeon Blaster up on a clean **Windows 11** machine. Written for a fresh install, not
for the reference laptop — assume nothing is already there.

Every version below was read off the reference machine during this session, not typed from
memory. Where the reference machine and a sensible default disagree, the reference machine is
named and so is the difference.

Reference machine (for context, not a requirement): Ryzen 7 8840HS, 8C/16T, 32 GB DDR5-5600,
RTX 4060 Laptop 8 GB (driver 621.14), 240 W brick, Windows 11 x64.

---

## 0. Hardware and disk before anything installs

| | Floor | Reference machine | Why it is a floor |
|---|---|---|---|
| RAM | 32 GB | 32 GB | The DM artifact alone maps 17.97 GiB. 16 GB does not fit; it will thrash. |
| CPU | 8 cores / 16 threads | Ryzen 7 8840HS | The DM decodes on CPU **by design** — the GPU is for narrator TTS and image generation. |
| GPU | 8 GB VRAM, NVIDIA Turing or newer | RTX 4060 Laptop 8 GB | Needed only for OmniVoice TTS and ComfyUI. No GPU ⇒ no GPU paths, everything else runs. |
| Free disk | 60 GB | — | Model 18 GiB + a fresh ComfyUI with models + audio ~2 GiB + headroom for the asset cache. |
| Power | **Plugged into a ≥200 W brick** | 240 W, "Turbo" plan | Not a joke: TTS moved 3.3× and image generation 3.6× between the 45 W and 120 W envelopes. Every timing in this repo was taken plugged in. |

Put the model and the asset cache **outside any synced folder** (OneDrive, Google Drive, Dropbox).
A 18 GiB file inside OneDrive is a sync-loop and a half-finished download waiting to be loaded.

```powershell
# The convention used throughout this repo's launchers:
mkdir C:\dm\models C:\dm\bin C:\dm\logs C:\dm\voice C:\dm\audio -Force
```

---

## 1. Install order

Do these in order; each row's "verify" column is the actual command and the actual expected answer.

| # | Component | Version to get | From | Verify |
|---|---|---|---|---|
| 1 | Git for Windows | 2.56.x (any recent) | git-scm.com | `git --version` → `git version 2.56.0.windows.4` |
| 2 | **Node.js LTS ≥ 22.19** | 22.x LTS or newer | nodejs.org | `node --version` → `v22.x` — see §2, this one bites |
| 3 | Pi coding agent | latest | `npm i -g @earendil-works/pi-coding-agent` | `pi --version`; installed release here is 1.5.0 |
| 4 | This repo | `main` | `git clone https://github.com/HubGittin55/Dungeon-Blaster.git` | `npm test` → **`29 passed, 0 failed`** |
| 5 | llama.cpp server (prebuilt Windows x64) | any build with `--no-repack` + `--spec-type` | llama.cpp releases, `win-cpu-avx2` (or `win-cpu-avx512` on Zen 4/5) | `llama-server.exe --version` → reference build is `0.9.0-dev (build 12144, commit 69ee2ecc0)`, Clang 20.1.8 |
| 6 | DM model weights | `...-Genesis-MTP-MXFP4.gguf` (20.06 GiB) for first boot; shipping build is a local requant — §4 | HuggingFace `LuffyTheFox/…` | `sha256sum` matches §4 |
| 7 | audio.cpp CPU build | `audio-v0.9.4-bin-windows-x64-<cpu>.zip` | audio.cpp releases (reference runs v0.9.4, git `f7ac446f`) | `curl.exe -s --noproxy '*' http://127.0.0.1:8081/health` |
| 8 | eSpeak-ng | latest 1.51.x installer | github.com/espeak-ng/espeak-ng/releases | Kokoro TTS is dead without it. `ESPEAK_DATA_PATH` must point at the **parent** of `espeak-ng-data` |
| 9 | audio models | §5 table | HuggingFace | `GET :8081/v1/audio/voices` returns the Kokoro catalog |
| 10 | audio.cpp CUDA build + its CUDA runtime zip | `audio-v0.9.4-bin-windows-x64-cuda13.3.zip` **and** `audio-v0.9.4-cudart-windows-x64-cuda13.3.zip` | audio.cpp releases | `curl.exe -s --noproxy '*' http://127.0.0.1:8082/health` |
| 11 | ComfyUI + embedded Python | ComfyUI 0.44.0, frontend 1.58.5, python_embeded 3.11.6 | ComfyUI Windows zip | `curl.exe -s --noproxy '*' http://127.0.0.1:8188/system_stats` |
| 12 | PyTorch CUDA build (inside ComfyUI's python) | **`torch 2.15.0+cu134`** | PyTorch index, cu134 wheel | see §6 for the exact probe |
| 13 | Anima node + workflows | §6 | custom_nodes | `ComfyUI-Anima-2.9B-loraPatch` **is not optional** |
| 14 | Comfy MCP server for Pi | `@miller-joe/comfyui-mcp` | npm | `~/.pi/agent/mcp.json`, see §6 |
| 15 | *(optional)* Browser for the agent bridge | any Chromium/Firefox | — | only if you want the Pi↔Stunkus bridge; needs desktop UI Automation |
| 16 | *(optional)* WebView2 runtime | Evergreen, preinstalled on Win11 | — | game client target; nothing else needs it |

Nothing here is compiled. **No Visual Studio, no CMake, no compiler** — every binary above ships
as a Windows x64 release. If a doc tells you to build llama.cpp from source, that doc is stale.

---

## 2. Node: two different floors, and this is the one people get wrong

- The Pi coding agent declares `engines.node: ">=22.19.0"`. **Not 22 — 22.19.0.** Install the
  current 22.x LTS (or newer; the review pass ran the suite on Node 24).
- This repo's own code (tracker, gate, engine, tests) declares `engines.node: ">=20"` and is
  verified on **v20.15.0** as well as 22 and 24.

The reference laptop still has Node 20.15.0 on `PATH` and runs Pi through a wrapper that supplies
its own runtime. That works and it is also a trap: a fresh machine that installs Node 20 gets a
Pi that refuses to run, and `npm test` still passes, so the failure looks like Pi being broken
rather than the version floor. **Install 22 LTS and let `npm test` run on it too.**

```powershell
node --version    # want >= v22.19.0
npm test          # want: 29 passed, 0 failed
```

---

## 3. Pi setup

```powershell
npm i -g @earendil-works/pi-coding-agent
```

Then in `~/.pi/agent/settings.json` (or your shell profile) — the game master extension reads
these, and every one has a working default:

| Variable | Default | Purpose |
|---|---|---|
| `DB_DM_URL` | `http://127.0.0.1:8080` | where the DM server lives |
| `DB_DM_MODEL` | *(empty ⇒ ask the server)* | model id for `/v1/chat/completions` |
| `DB_DM_TEMPERATURE` | `0.8` | |
| `DB_DM_MAX_TOKENS` | `900` | round narration budget |
| `DB_TTS_URL` | *(unset ⇒ narration is silent)* | narrator TTS endpoint, e.g. `http://127.0.0.1:8082/v1/audio/speech` |
| `DB_RULES` | `rules/rules.md` | the rulebook the gate parses |
| `DB_PERSIST` | *(unset)* | set to enable the JSONL + snapshot ledger |
| `DB_MAX_PER_HOUR` | `6` | AFK headless-run rate cap (bridge) |
| `DB_MUSE_MATCH` | *(unset)* | window-match string for the agent bridge |

`curl.exe`, not `Invoke-RestMethod`, for anything on localhost: on the reference box `IRM`
honours WPAD proxy discovery and quietly routes `127.0.0.1` through a proxy that isn't there.
Always pass `--noproxy '*'`.

---

## 4. The DM model — where to actually get it

Two artifacts matter below. Know which one you are holding, because every speed number in this repo
belongs to the shipping build and not to the download:

**Shipping artifact (what these measurements are from):**

```
Hermes3.6-35B-A3B-MTP-MXFP4exp-Q4K_S.gguf
bytes    19,297,351,104  (17.97 GiB)
sha256   219ac0c72f2965e4a1cdf6f4ceaa612b913fe3c6598c51e7c293c2d4d60d16a7
```

### Start here: the closest quant the LLM's repo actually publishes

HuggingFace: **`LuffyTheFox/Qwen3.6-35B-A3B-A3B-Uncensored-Genesis-Hermes-MTP-GGUF`**

The repo is 131 GB. **Pull exactly one file.** The shipping artifact above is a local requant and is
not in the repo; the closest thing that *is* downloadable is the vendor's MXFP4, and that is a fine
way to get a first DM running today:

```
Hermes3.6-35B-A3B-Uncensored-Genesis-MTP-MXFP4.gguf
bytes   21,543,974,336  (20.06 GiB)
sha256  f167e7d2c6661e01f3a57821aa8a411b51c94e28c7324ef566376c3e54daea74
```

Same weights underneath, same Genesis repair, same Hermes function-calling graft, same MTP head —
it is a quantization choice, not a different model, so every behavioral claim and the turn contract
still hold. License is **Apache-2.0**, which (unlike the Anima weights in §6) is clean for shipping.

| file in the repo | size | runs on 32 GB? | measured on the reference box | use it for |
|---|---|---|---|---|
| `...-MTP-MXFP4.gguf` | 20.06 GiB | yes | **15.5 best / 14.5 mean tok/s** | **first boot — one download, works today** |
| `...-MXFP4.gguf` | 19.23 GiB | yes | not benched solo (MTP runs `--spec-type none` anyway) | A/B control only |
| `...-MTP-Q8_K_P.gguf` | 41.45 GiB | **no** | ~12 tok/s, 3.3 GiB/token | requant source, and the repo's own "recommended quant" is off-table here |
| `...-Q8_K_P.gguf` | 41.45 GiB | **no** | ~12 tok/s | requant source |
| `mmproj-...-F16.gguf` | 0.84 GiB | — | — | vision; not in slices 1–3 |

Requant source, when you want it: `Hermes3.6-35B-A3B-Uncensored-Genesis-MTP-Q8_K_P.gguf`,
44,502,971,840 bytes, sha256 `50c7ee02ff1aa09977d517033564674ad8bebbe31d36e62dfae5c9c325d8f0d7`.

### What the download costs, stated as a number rather than a shrug

Decode on this class of machine is RAM-bandwidth-bound, so speed is bytes-read-per-token divided by
bandwidth, and the two files differ in exactly that one term:

| artifact | GiB read per token | tok/s best / mean | a 900-token round |
|---|---|---|---|
| shipping requant | 1.71 | **20.5 / 20.4** | ~44 s |
| vendor MXFP4 | 2.50 | **15.5 / 14.5** | ~58 s |

Same ~35–39 GB/s of measured bandwidth in both rows. The vendor build keeps its dense path in Q8_0;
that tax is the entire 24%.

Most of that gap hides under narration, which is audio-bottlenecked at ~3–4 tok/s of spoken word
against 15–21 tok/s of decode — but the part that does not hide is the `resolve_round` tool-call
burst, where decode *is* the wait, and 14 seconds of extra dead air per round is a lot at a table.
So: **boot on the download; if the round loop feels slow, restore the measured artifact.** Perplexity
is not the reason to bother — the requant measured inside the original's confidence interval (+1.73%,
PPL 4.4015 ± 0.18735). Speed is the only reason.

**Restoring the shipping artifact — copy it (preferred):** take the file from a machine that has it
and check the §4 hash against a different model than every number in this repo. Any other hash means
you are benchmarking something else.

**Or requant it** — this is the exact command that produced it:

```
llama-quantize.exe --allow-requantize --tensor-type "ffn_.*_exps\.weight=MXFP4" \
  --output-tensor-type Q6_K --token-embedding-type Q6_K \
  <Q8_K_P input> <output> Q4K_S 14
```

MXFP4 stays on the routed experts so the *sparse* pool does not grow; Q6_K on the output and token
embeddings matches what the fast third-party quant does for the logits path.

### The "nearly no difference" pair, so nobody buys the wrong file for speed

The 1% gap people remember is **shipping requant (20.5 / 20.4) vs
`HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-IQ4_XS.gguf` (20.3 / 20.1)** — statistically
identical, which is what proved the Q8_0-dense tax was the only thing holding the vendor file back.

**Do not swap to IQ4_XS to buy speed.** That file is the *base "Aggressive" merge*: no Genesis
tensor repair, no Hermes function-calling graft, no MTP head. It was a bandwidth probe, it is a
different model, and it cannot serve the `resolve_round` contract — the one thing the DM is
load-bearing for. It is not in the Hermes repo either, so "closest available quant" cannot mean it.
Full evidence: `notes/model-review-qwen36-hermes-mtp.md`.

You also need the **chat template**: the server runs with `--jinja --chat-template-file`, so a
template file must exist. Reference: `C:\dm\models\chat_template.jinja`; a copy is tracked at
`notes/chat_template.jinja`.

### Launch flags (the working set, verbatim from the running server)

```powershell
llama-server.exe -m C:\dm\models\Hermes3.6-35B-A3B-MTP-MXFP4exp-Q4K_S.gguf `
  --chat-template-file C:\dm\models\chat_template.jinja --jinja `
  --reasoning off --no-reasoning-preserve `
  -c 32768 -np 1 -t 14 -fa on `
  --cache-type-k f16 --cache-type-v f16 --cache-reuse 8192 `
  --no-repack `
  --spec-type none --spec-draft-n-max 2 --spec-draft-p-min 0.15 `
  --no-webui --host 127.0.0.1 --port 8080
```

Non-negotiable, each of these is a measured result and not a preference:

- **`--no-repack`** — repack is *on by default* and spends ~18 GiB building a private copy of the
  weights for a bandwidth-bound decode it cannot speed up. RSS drops 25.5 → 12.2 GiB with it off.
- **`--spec-type none`** — MTP was measured as a loss on this artifact and this card. Locked off.
  (`--spec-draft-*` stay at their defaults for when that changes.)
- **`--reasoning off --no-reasoning-preserve`** — the turn contract needs the tool call, not a
  thinking block.
- **JSON Schema `response_format`** on the request — `json_object` alone measured 0/4 contract
  compliance; native tool calls measured 4/4 (`spikes/spike_toolcall.py`, at the cost of ~730
  prompt tokens).

Prompt layout, because it costs 150 seconds to get wrong: the prefix (persona, rules) is immutable
for the whole campaign and **mutable world state is appended as fresh trailing turns, never
edited into the prefix**. A single changed digit anywhere in a 16 K prefix forced a full ~151 s
re-eval. Evidence: `notes/probe_d_prefix.py`, `notes/probe_d2_stateedit.py`.

---

## 5. Voice: STT, VAD, narrator TTS

Two separate audio.cpp installs, because **the CPU build has no CUDA path** and they are
deliberately not allowed to fail each other:

| Port | Build | Does | Config |
|---|---|---|---|
| 8081 | CPU | ASR + VAD + Kokoro (fallback voice) | `C:\dm\audio\server.json` |
| 8082 | CUDA | OmniVoice narrator — reference-voice cloning, streaming | `C:\dm\audio\server-cuda.json` |

Both ship the **same executable name**, `audiocpp_server.exe`. The launcher kills the old one by
matching on the install directory, because matching on process name took down 8082 while restarting
8081. Do not "simplify" that.

### audio.cpp — prebuilt binaries, not a source build

| zip | contents |
|---|---|
| `audio-v0.9.4-bin-windows-x64-cpu.zip` | `audiocpp_server.exe` + ggml CPU variants → `C:\dm\bin\audio\x` |
| `audio-v0.9.4-bin-windows-x64-cuda13.3.zip` (266 MB) | `audiocpp_server.exe` + `ggml-cuda.dll` (258 MB) → `C:\dm\bin\audio\cuda` |
| `audio-v0.9.4-cudart-windows-x64-cuda13.3.zip` (549 MB) | **only** the CUDA runtime DLLs: `cudart64_13`, `cublas64_13`, `cublasLt64_13`, `cufft64_12` |

That third zip is why you do not need a CUDA toolkit installed. You need one only if you insist on
compiling audio.cpp yourself.

### Models to download

| id | family / task | file | source |
|---|---|---|---|
| `asr` | `parakeet_tdt` / ASR | `parakeet-tdt-0.6b-v3-q8_0.gguf` | HuggingFace (`Parakeet-TDT-0.6B-v3-GGUF`) |
| `vad` | `firered_stream_vad` | `firered-stream-vad-f32.gguf` (2.2 MB) | HuggingFace `audio-cpp/audio.cpp-gguf` |
| `tts` | `kokoro` (fallback) | `kokoro-82m-q8_0.gguf` | HuggingFace `Kokoro-82M-GGUF` |
| `tts` | `omnivoice` (narrator) | `omnivoice-q8_0.gguf` | HuggingFace `OmniVoice-GGUF` |

Config notes that are load-bearing:

- `lazy_load: false` on the CPU server, and `max_loaded_models: 3`. With lazy loading, the first
  request of a session pays the model load *inside the request* — that is the latency we promised
  not to have on the first turn.
- ASR runs `mode: "offline"` on purpose: `mode: streaming` 500s on `/v1/audio/transcriptions`.
- `threads: 4` on 8081 so the DM keeps the cores; `max_loaded_models: 1` on 8082.
- Kokoro needs eSpeak-ng; set `ESPEAK_DATA_PATH` to the directory *containing* `espeak-ng-data`.

### The clone contract (undocumented upstream, and it fails silently)

OmniVoice voice cloning needs **both** `voice_ref=<wav path>` and
`options.reference_text=<exact transcript of that wav>`. Omit `reference_text` and the server
returns **200 with the model's default voice** — a confident, wrong-sounding narrator rather than
an error. The transcript has to match the clip.

Narrator presets on the reference machine live in `C:\dm\voice\speakers\` as
`<name>.wav` + `<name>.transcript.txt` + `<name>.json`. **Those clips are not in this repo** —
bring your own references (16 s of clean, single-speaker audio is enough) and rebuild the presets.
Shipping settings: `num_inference_steps = 6`, `preprocess_prompt = false`, measured 0.34 s per
57-character sentence at RTF 0.08 on the 240 W brick (1.10 s at 45 W — the same workload moved
3.3× on the power envelope alone).

---

## 6. Images: ComfyUI, Anima, and the MCP server

This whole section is optional at first boot — the game plays without art — but it is the only
part of the stack with a **licensing problem** (§6.4). Read that before shipping anything.

### 6.1 Install

ComfyUI's Windows zip brings its own `python_embeded` (3.11.6). Reference install: ComfyUI
**0.44.0**, frontend **1.58.5**.

Launched as:

```
python_embeded\python.exe ComfyUI\main.py --fast --disable-partner-nodes --disable-xformers --listen 0.0.0.0
```

`--listen 0.0.0.0` puts ComfyUI **on the LAN with no authentication**. Fine on a trusted table
network, not fine on hotel wifi — drop it to `--listen 127.0.0.1` if you are anywhere else.

### 6.2 GPU stack — measured, and it corrects the draft

```
python     3.11.6
torch      2.15.0+cu134
cuda rt    13.4          <- what the cu134 wheel actually carries
cudnn      9.26
driver     621.14        <- kernel-mode driver, this is the version floor that matters
device     RTX 4060 Laptop GPU, 8188 MiB
```

- The runtime comes **from the torch wheel**. A standalone CUDA toolkit is not required at
  runtime; the reference machine has only toolkit v12.8 installed and nothing in this stack uses
  it, because CUDA 13.x user-mode libraries come from the driver.
- **Do not install `flash_attn` or `sageattention`.** No Windows wheels exist for this torch/CUDA
  combination; they install as dead weight and shadow each other. Core attention runs on torch
  SDPA (`attention_pytorch`) and that is the shipping path. `--disable-xformers` and
  `--disable-partner-nodes` keep a stale xformers from crashing startup.

### 6.3 Anima workflow files

`ComfyUI-Anima-2.9B-loraPatch` is a **global monkeypatch and is required** — without it the
Anima node graph does not run. Real filenames used by the tracked workflows
(`C:\dm\comfy\anima_card_api.json`, MCP template `anima-card-640`):

| file | role |
|---|---|
| `anima-base-v1.0.safetensors` | Anima base (upstream) |
| `SilvermoonMix-Anima2B-Evolved-V2.3-INT8-ConvRot.safetensors` (3.16 GB) | the mix actually loaded locally via `UNETLoader` |
| `Anima-Lora\anima-turbo-lora-v0.2.safetensors` (142 MiB) | turbo LoRA, 1016 tensors |
| `qwen_3_06b_base.safetensors`, `qwen_image_vae.safetensors` | text encoder / VAE |

`LoraLoader.lora_name` is validated as an **exact string**, backslashes and all:
`"Anima-Lora\\anima-turbo-lora-v0.2.safetensors"`.

Shipping card settings: **640×640, 4–8 steps, cfg 1**, measured 1.22–1.91 s per card. ComfyUI's
prompt cache needs the seed *and* the prefix to vary. Never fire a big render immediately before a
line of narration — it steals the GPU from TTS.

### 6.4 License — closed by the owner (2026-11-08), recorded so it stays closed

Anima ships under the **CircleStone Labs Non-Commercial License**, and it is a derivative of
Cosmos-Predict2-2B-Text2Image, so the **NVIDIA Open Model License** applies to derivatives too:
*the model and derivatives are only usable for non-commercial purposes.* `SilvermoonMix-Anima-
Evolved` carries its own `license: other`.

**Blarmo's ruling:** Dungeon Blaster is a personal project and will never be sold, distributed, or
run commercially or for profit. Model weights are never hosted in the repo and never leave his
machine — the model runs locally on hardware he owns, for himself. Non-commercial is the project
specification, not an exception being argued for. Full analysis in `notes/comfyui-anima.md` §6.

Art is pre-generated into a manifest regardless, and the reason is latency rather than licensing: a
cold render must never land in the middle of a spoken line, and the same item should look the same
twice. See `game/art/manifest.json` and `game/art/bakeoff.mjs`.

### 6.5 MCP wiring

`~/.pi/agent/mcp.json`:

```json
{ "mcpServers": { "comfy": {
  "command": "node",
  "args": ["C:/dm/mcp/node_modules/@miller-joe/comfyui-mcp/dist/index.js",
           "--stdio", "--comfyui-url", "http://127.0.0.1:8188"],
  "env": { "COMFYUI_URL": "http://127.0.0.1:8188",
           "COMFYUI_DEFAULT_CKPT": "<your default checkpoint>" }
} } }
```

Install it wherever you like (`npm i @miller-joe/comfyui-mcp` into a dedicated folder beats a
global install) and point `args` at it. One running ComfyUI is enough — do not start a second one
for the MCP.

---

## 7. Machine setup that changes measurements

- **Power plan**: high performance / "Turbo". **Brick attached.** Re-state brick + plan + clocks
  with every number you record, or the number is not reproducible.
- **Sleep and hibernate off** while a session is running. A 18 GiB model that gets paged out costs
  a 150-second re-eval on wake.
- **Defender**: `C:\dm` is a good exclusion candidate (an 18 GiB file that gets scanned at load
  time is a cold start you will not understand). Measure with it on and off; do not guess.
- **Outside OneDrive.** Non-negotiable for models, logs, and the asset cache.
- **First turn is cold.** Either send a warm-up request or run with `--load-mode mlock`; a cold
  first turn measured 4.32 s to first audio token against 2.55 s warm.
- RAM co-presence (DM + two audio servers + ComfyUI all resident at once) is **still unmeasured**.

---

## 8. Verify the whole stack in one paste

```bash
curl.exe -s --noproxy '*' http://127.0.0.1:8080/health          # -> {"status":"ok"}
curl.exe -s --noproxy '*' http://127.0.0.1:8080/props | head -c 300
curl.exe -s --noproxy '*' http://127.0.0.1:8081/health           # -> ok, ASR/VAD/Kokoro loaded
curl.exe -s --noproxy '*' http://127.0.0.1:8082/health           # -> ok, OmniVoice loaded
curl.exe -s --noproxy '*' http://127.0.0.1:8188/system_stats | head -c 200
npm test                                                          # -> 29 passed, 0 failed
```

Expected ports: **8080** DM (CPU), **8081** audio CPU (ASR/VAD/Kokoro), **8082** audio CUDA
(OmniVoice narrator), **8188** ComfyUI. The d20 spike serves on **8090** when you start it.

Latency envelope from the reference machine, so a new machine can be compared against something:
STT 0.28 s · VAD ~20 ms · OmniVoice 0.34 s per 57-char sentence · DM 2.55 s warm / 4.32 s cold to
first token · DM decode 20.4–20.5 tok/s on long outputs.

---

## 9. Not required

- **No Linux layer, no VM, no Docker.** Native Windows x64 for everything.
- **No compiler.** No Visual Studio, no CMake, no `pip install` of anything compiled.
- **No CUDA toolkit** unless you build audio.cpp yourself.
- **No GPU for the DM.** The 35B decodes on CPU by design.
- **No Python** for the DM or voice path. Python exists only inside ComfyUI.
- **No network at runtime** after the downloads, except the Comfy MCP's localhost HTTP.

---

## 10. Traps, each one earned

1. `--no-repack` or you silently spend 18 GiB and go *slower*.
2. `Invoke-RestMethod` on localhost goes through WPAD. Use `curl.exe --noproxy '*'`.
3. Both audio.cpp builds are `audiocpp_server.exe`. Kill by path, not name.
4. The CPU audio build has no CUDA path. Two installs, two ports, on purpose.
5. eSpeak-ng missing ⇒ Kokoro answers nothing.
6. OmniVoice clone without `reference_text` ⇒ HTTP 200, wrong voice.
7. `json_object` alone breaks the turn contract; use JSON Schema / native tool calls.
8. One edited digit in a 16 K prefix ⇒ ~151 s re-eval. Append state, never edit the prefix.
9. Timings on battery are fiction. Record brick + plan with every measurement.
10. `flash_attn` / `sageattention` cannot install cleanly here; SDPA is the shipping path.
11. `--listen 0.0.0.0` on ComfyUI is an unauthenticated LAN service.
12. Node 20 runs the tests and refuses to run Pi. Pi needs **22.19.0+**.

---

## 11. Known gaps in this document

- The **launcher scripts are not vendored into this repo yet.** `notes/start-dm.ps1` is a tracked
  copy and has already drifted from the one actually running on the reference machine
  (`C:\dm\start-dm.ps1`, plus `start-audio.ps1` and `start-audio-gpu.ps1`). Until that is fixed,
  §4's flag block is the authoritative launch line.
- **Nothing here has been run on a second machine.** Glenzano's Windows 11 boot is the intended
  first test; expect the first pass to be about drivers, power plans, and paths.
- Art is pre-generated by design, so the manifest is never empty at first launch only if a batch has
  been run; a miss currently means a placeholder card rather than a queued job.
- Game-client RAM footprint, four-player mic attribution, and RAM co-presence are all still
  unmeasured.

---

## Corrections applied to the hand-written draft this file started from

| The draft said | The machine says |
|---|---|
| "Node.js 22 LTS or newer (Pi needs 22+)" | Pi needs **≥ 22.19.0** specifically; repo code needs ≥ 20 and is verified on 20.15.0. The reference box has 20.15.0 on `PATH`, which is exactly the trap. |
| "audio.cpp built from source (STT plus OmniVoice TTS)" | **Not built from source** — official prebuilt Windows zips. And it is **two** installs: CPU build for STT/VAD/Kokoro on 8081, separate CUDA build for OmniVoice on 8082, plus a separate CUDA-runtime zip. |
| "CUDA 13.5 and PyTorch 2.15 (cu134)" | torch `2.15.0+cu134` carrying CUDA **13.4** runtime, cuDNN 9.26, driver 621.14. Only toolkit v12.8 is installed and nothing at runtime uses it. audio.cpp ships `-cuda13.3` binaries. There is no 13.5 anywhere. |
| "llama-server … serving the artifact with `--spec-type none --no-repack --reasoning off`" | Right three flags, incomplete set: also needs `--no-reasoning-preserve`, `--jinja --chat-template-file` (the template file is a dependency), `-c 32768 -np 1 -t 14 -fa on`, f16 KV cache + `--cache-reuse 8192`, and JSON Schema `response_format` on the request. |
| *(omitted)* | The draft named a file that **is not published anywhere** — the shipping artifact is a local requant. §4 now leads with the closest quant the LLM repo actually publishes (vendor MXFP4, one 20.06 GiB download) and prices it honestly at 15.5 vs 20.5 tok/s, since the near-tie people remember is against IQ4_XS, which is a different model with no tool-call graft. Also missing: eSpeak-ng, the four audio model files, `ComfyUI-Anima-2.9B-loraPatch`, the Anima license gate, and every power/disk constraint above. |
