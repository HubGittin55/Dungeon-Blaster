# Voice stack: TTS / STT / VAD, measured on this laptop

Everything below is measured on the target box (Ryzen 7 8840HS, 32 GB, native Windows, no GPU for
audio) against audio.cpp v0.9.4 CPU (`C:\dm\bin\audio\x\audiocpp_server.exe`, git `f7ac446f`) and the
adopted DM artifact `Hermes3.6-35B-A3B-MTP-MXFP4exp-Q4K_S.gguf` at 20.4 tok/s. Scripts live in
`C:\dm\voice\`; the pipeline is `dm_voice.py`.

## 0. The headline

| stage | measured | verdict |
|---|---|---|
| STT (4.45 s utterance, whole-file POST) | **0.26-0.35 s** (RTF 0.06-0.10) | not a problem, ever |
| VAD (10.9 s of audio, whole-file) | **0.017-0.020 s** (~500x realtime) | cheap enough to poll live |
| TTS, one ~45-char sentence | **1.15-1.40 s** (RTF ~0.38, 2.6x realtime) | fine, and it pipelines per sentence |
| TTS, first audio via `/speech/live` | **1.06 s** for a 40-char sentence | ~0.3 s better than whole-sentence; not the bottleneck |
| **DM first token** | **2.55 s warm, 4.32 s cold** | **this is the bottleneck, ~2x the whole rest of the budget** |
| DM narration generation | 20.4 tok/s | 5-6x the 3-4 tok/s spoken rate |
| **Narrator TTS: OmniVoice clone, GPU** | **0.34 s** for a 57-char sentence (RTF 0.08, ~12x realtime) on the 240 W brick; **1.10 s** at the old 45 W envelope | Jason Statham narrator, cloned from a 16 s reference. See 6.6 |
| Narrator TTS: same model on CPU | 6.2x realtime without a reference, **70x with one** | dead on CPU; the 4060 is not optional |

So the audio stack is not what stands between us and a <2 s turn: **the DM's time-to-first-token is**.
Two consequences, both in §5.

## 1. audio.cpp's real API (the README lists 6 endpoints; the binary has ~30)

Discovered by reading the binary's own embedded help and error strings, not the README
(`C:\dm\bin\audio\x\audiocpp_server.exe`, strings around the route table), and by probing.

| endpoint | what it actually is |
|---|---|
| `POST /v1/audio/speech` | whole-utterance synth. **`response_format` is ignored** - wav/pcm/mp3 all returned the identical 24 kHz s16 mono WAV. Answers with raw bytes, not JSON. |
| `POST /v1/audio/speech/live?model=tts&input=<text>&stream_format=sse\|audio` | SSE `speech.audio.delta` (base64 pcm) + `speech.audio.done`. **`input` must be a non-empty query param and is treated as the complete text**: the chunked body is never consumed (the server answers before the first body chunk lands, even when the first increment is in the same packet as the headers). So it cannot stream *text in*; it does stream *audio out*. |
| `POST /v1/audio/transcriptions` | multipart WAV in (WAV only; "MP3 support is planned"), `{text, timing}` out. **Needs `mode=offline`.** |
| `POST /v1/audio/transcriptions/live?model=asr` | raw PCM in a chunked body, SSE `transcript.text.delta` / `.done`. **Needs `mode=streaming`.** |
| `POST /v1/tasks/run` `{"model":"vad","task":"vad","audio":"<abs path>"}` | `{segments:[{start_sample,end_sample,confidence}], timing}`. `audio` is a **filesystem path** (a data URI gets joined onto the cwd and reported as "could not open WAV"). Wrong key names fail as "FireRed VAD requires 16000 Hz mono audio", which is a misleading error, not a real rate complaint. |
| `GET /v1/audio/voices?model=tts` | voice presets from server.json merged over the Kokoro catalog (89 ids embedded: af_/am_ US, bf_/bm_ UK, plus de/es/fr/it/ja/zh/etc.) |
| `POST /v1/models/load` etc. | needs `ui_management: true`; we don't need it (see preload below) |

Config gotchas that cost real time:
- **`lazy_load: true` means the first request of a session pays the model load**, and `/v1/models`
  cheerfully reports `loaded: false` while healthy. Set `lazy_load: false`; all three models are then
  resident 2 s after launch and stay there.
- **`mode` is per model and is not just a label.** `mode: streaming` makes `/v1/audio/transcriptions`
  return 500; `mode: offline` makes the `/live` endpoints refuse. ASR is therefore **offline**, TTS is
  **streaming** (so `/speech/live` is usable), VAD is **offline**.
- **FireRedVAD ships as two different checkpoints.** `firered-vad-f32.gguf` (offline) is rejected in
  streaming mode ("FireRed VAD streaming requires the Stream-VAD checkpoint"); the stream variant is
  `firered-stream-vad-f32.gguf`, 2.2 MB, `audio-cpp/audio.cpp-gguf`.
- Kokoro TTS needs eSpeak-ng at runtime (installed, `ESPEAK_DATA_PATH=C:\dm\bin\audio\x`).
- `server.json` gained a cast in `voice_presets`: `dm`=af_heart, `p1`=am_fenrir, `p2`=bf_isabella,
  `p3`=am_onyx, `p4`=af_nova, `npc_m`=bm_george, `npc_f`=af_sky. All seven verified audible and
  distinct (peaks 9.7k-21.7k, durations differ). Keyed by slot so the game never hardcodes a timbre.

## 2. Streaming ASR: works, and we are not using it for turn-taking

`/v1/audio/transcriptions/live` does produce partials while you speak (first partial ~2.1 s *before*
the end of a 4.45 s utterance), which is nice for on-screen captions. But:

1. **No endpoint event.** `transcript.text.done` arrives only when the client closes the body. Tried
   `audio_chunk_mode=vad` and an explicit `vad_model_path` pointing at the Stream-VAD checkpoint: same.
   So the server never tells us "the player has finished", which is the one thing turn-taking needs.
2. **It fell behind realtime** on continuous streaming (`streaming_attention_mode: full_context`
   re-attends the whole buffer, so cost grows with utterance length).

Whole-file STT at RTF 0.06-0.10 with client-side endpointing is both simpler and faster to a *usable*
transcript: end-of-speech + 350 ms hangover + ~0.3 s STT. Keep `/live` in reserve for captions.

## 3. Endpointing design (what `dm_voice.py` does)

FireRedVAD with default options splits speech at **50 ms** prosodic pauses (it found 4 "utterances" in
two sentences), which is useless for turn-taking. With
`{threshold: 0.4, min_silence_duration_ms: 300, merge_silence_duration_ms: 300}` it behaves. Because a
VAD call over 10 s of audio costs 20 ms, the mic path just **polls a rolling window every 200 ms** and
ends the turn when trailing speech ends are >350 ms behind the capture head, then POSTs exactly the
utterance (trimmed at last speech + 150 ms) to whole-file STT. Push-to-talk (hold SPACE) is the
fallback for a loud table, and both paths feed the same turn function.

Mic topology on this laptop: one physical array (`Microphone Array (Realtek(R) Audio)`, 2 ch, default)
plus virtual Steam devices and BT headset entries. **Four players cannot be attributed to slots from
one array** - that needs either per-slot push-to-talk (deterministic, no diarization) or USB headsets.
audio.cpp does have diarization + `speaker_turns` in its task API, but diarizing four people speaking
over one omnidirectional laptop mic is not a bet to build on. Open question for the game-logic phase.

## 4. Turn assembly

`dm_voice.py`: mic/PTT or `--say`/`--selftest` -> STT -> DM (`/v1/chat/completions`, streaming,
`response_format=json_schema` on `resolve_round`) -> **sentence-level splitter on the partially
streamed JSON** -> per-sentence TTS -> a `Speaker` queue that plays sentence N while N+1 synthesizes.
It parses narration out of the still-incomplete JSON so speech can start mid-stream, and only speaks
text up to the last sentence terminator (never a fragment like "the torchlight gut").

Selftest = TTS a synthetic player line, feed it through the chain, time every edge. Reproducible
without a human speaking:
`python C:\dm\voice\dm_voice.py --selftest [--order narration_first|mutations_first]`

## 5. The finding that matters: narration ordering is worth 3.1 seconds

Same prompt, same servers, warm DM, two schema emissions (both keys still required, only order changes):

| emission order | first audio at | total |
|---|---|---|
| mutations, then narration (current locked contract) | **11.05 s** | 16.07 s |
| **narration, then mutations** | **7.92 s** | 9.91 s |

Mutations-first exists so the gate can validate state changes ASAP. But the gate cannot apply anything
until the whole object parses anyway, so mutations-first only buys *earlier rejection*, while costing
**3.1 s of dead air** - narration is what the players are waiting to hear, and it is now generated last.
This needs re-deciding before the tracker exists, not after; the fix is one reordered `required` list
in `C:\dm\resolve_round.schema.json`, plus a gate that reads `mutations` from the completed object
either way.

And the other 2.5 s: **DM TTFT is 2.55 s warm / 4.32 s cold for a ~250-token prompt**, i.e. pure
prefill at ~98 tok/s plus page-faulting an 18 GiB mmap. Nothing in the audio stack can compensate for
that. Probe D (warm prefix-cache TTFT at 12-20 K context, the hybrid DeltaNet question) is now the
highest-value measurement in the whole project, and `--load-mode mlock` (or a warm-up request in
`start-dm.ps1`) is the cheap experiment for the cold-start half.

## 6. The shipping narrator: OmniVoice voice clone on the RTX 4060

**Engine decision (user's): strictly KittenTTS 2 or OmniVoice.** OmniVoice won on three counts: 1.26 GB
q8_0 vs KittenTTS 2's 3.19 GB, it *streams* (KittenTTS 2 is offline-only, so it cannot start audio
before the whole sentence exists), and it does voice design as well as cloning. audio.cpp also contains
XTTS-v2, F5-TTS, IndexTTS2.5, Echo-TTS, Chatterbox, CosyVoice3 and ~35 other engines; none are in play.

The `speakers/*.json` files that came with the voice pack are XTTS-v2 conditioning tensors
(`gpt_cond_latent` 32x1024 + `speaker_embedding` 512) and are **unused**. What matters from that pack is
the reference WAVs, so every one now carries a `.transcript.txt` produced by our own Parakeet ASR - the
transcript has to match the clip (below).

### CUDA deployment

audio.cpp ships separate CPU / CUDA / Vulkan / ROCm Windows builds and **the CPU build has no CUDA
path**, so the GPU needed its own binary and its own port:

| zip | what it is |
|---|---|
| `audio-v0.9.4-bin-windows-x64-cuda13.3.zip` (266 MB) | binaries: `audiocpp_server.exe`, `ggml-cuda.dll` (258 MB), ggml CPU variants |
| `audio-v0.9.4-cudart-windows-x64-cuda13.3.zip` (549 MB) | **only** `cudart64_13.dll`, `cublas64_13.dll`, `cublasLt64_13.dll`, `cufft64_12.dll` |

Both unpacked into `C:\dm\bin\audio\cuda` next to the eSpeak-ng data, config
`C:\dm\audio\server-cuda.json`, launcher `C:\dm\start-audio-gpu.ps1`, port **8082**. It runs on the
existing 592.00 driver:

```
ggml_cuda_init: found 1 CUDA devices (Total VRAM: 8187 MiB):
  Device 0: NVIDIA GeForce RTX 4060 Laptop GPU, compute capability 8.9, VMM: yes
```

Healthy 2 s after launch, ~2.9 GB VRAM resident with OmniVoice loaded. Topology is now three servers:
**8080** llama-server (CPU, DM) / **8081** audio.cpp CPU (ASR, VAD, Kokoro fallback) / **8082**
audio.cpp CUDA (OmniVoice narrator). Launcher footgun fixed: the CPU launcher used to `Get-Process
audiocpp_server | Stop-Process`, which also killed the GPU server (same exe name, different install
directory); both launchers now match on `ExecutablePath`.

### The clone contract (README does not document it)

```json
POST :8082/v1/audio/speech
{"model":"tts","input":"...","voice_ref":"C:/dm/voice/speakers/jas-stthm.wav",
 "options":{"reference_text":"<transcript of that wav>"}}
```

- `voice_ref` is a **path**, at the top level. `reference_text` is **mandatory** alongside it (hard
  error: "OmniVoice native voice clone currently requires reference_text when reference audio is
  provided").
- **A wrong field name is not an error.** `reference_audio`, `voice:{kind:reference,...}` and friends
  return 200 with the model's *default* voice. Every clone assertion in `probe_omni3.py` therefore
  compares output hashes against a no-reference baseline instead of trusting the status code.
- server.json presets work and are what the game should use: `voice_presets: {dm: {voice_ref,
  reference_text}}`, requested as `"voice": "dm"`. Three presets are live (`dm` Jason, `npc_m`, `npc_f`),
  each verified to produce different bytes and a clean ASR round trip.

### 6.6 Re-measured on the 240 W brick - the narrator got 3.3x faster (`tts_rebench_120w.log`)

The table below was measured while the laptop was on a supply that capped it near 45 W. On the 240 W
brick, same build, same references, same seed discipline (`bench_omni2.py` again):

| setting | 45 W | **120 W** | ASR round trip |
|---|---|---|---|
| steps=10 | 1.68 s | **0.49 s** | perfect |
| **steps=6 (shipping)** | 1.13 s | **0.34 s** | perfect |
| steps=4 | 0.84 s | **0.26 s** | **still drops words** ("through the torch control site") |
| steps=6 preprocess=false | - | 0.34 s | perfect |
| steps=6 + denoise=false | 1.17 s | 0.35 s | clean here, still not worth 0.01 s |
| length scaling at steps=6 | - | 32ch 0.27 s / 57ch 0.34 s / 77ch 0.38 s | perfect |

nvidia-smi sampled at 1 s through the run: **2729 MHz mean, 76.9 W mean, 91.1 W peak** - the card is now
sustaining near-max clocks instead of sagging. RTF is 0.08 (4.08 s of audio in 0.34 s). Two consequences:

- steps=6 stays shipping: steps=4 is 0.08 s faster and still eats words. The word-drop is a model
  capacity limit at low steps, not a power limit.
- TTS is no longer a term in the latency budget at all. The selftest totals in the last section predate
  this envelope change and should be re-run; expect ~0.8 s off first audio, leaving DM TTFT as
  essentially the entire wait.

**Any future number, on either side of the box, gets the power envelope recorded with it** - this is the
second time a brick or a power plan silently moved a result by 2-3x.

### Measured on the 4060 at 45 W (bench_omni2.py: 3 warm-up calls discarded, every sample read back by ASR)

| setting | wall for a 57-char line | ASR round trip |
|---|---|---|
| steps=10 (default) | 1.68 s | perfect |
| **steps=6** | **1.13 s** | perfect |
| steps=4 | 0.84 s | **dropped words** ("War Band just falling") |
| steps=6 + denoise=false | 1.17 s | degraded ("warp, don't judge forward") |

Shipping defaults are therefore `num_inference_steps: 6`, `preprocess_prompt: false`, denoise left on.
Two traps this table encodes: **the first call after startup costs ~4.5 s** (CUDA graph capture, not a
per-request cost - an earlier sweep mistook it for one and drew the wrong conclusion), and **a
transcript that does not match the reference clip makes the model ramble**: a 57-char sentence came back
as 13.25 s of audio. Duration per 100 characters (5.3-6.4 s) is therefore checked as a gate, not a
footnote.

### Live SSE endpoint

`:8082/v1/audio/speech/live?...&voice=dm` gives first audio at **1.11 s** - the same as the offline call,
because this engine emits the whole sentence as **one** 183 KiB delta instead of streaming progressively.
Two consequences: SSE buys nothing yet for sentence-length lines, and **the live endpoint returned zero
bytes with no voice at all**, so the game must always pass a preset name. `audio_chunk_duration_sec` is
the untested knob that could make first audio earlier than whole-sentence synthesis.

### End to end with the Jason narrator (`dm_voice.py --selftest`)

| emission order | first audio | total |
|---|---|---|
| mutations, then narration | 12.41 s | 17.90 s |
| **narration, then mutations** | **5.63 s** | **9.04 s** |

STT 0.28 s, DM first token 2.71 s, first spoken sentence synthesized in 1.47 s. The audio stack is now
~1.5 s of a 5.6 s wait; the DM's 2.7 s prefill and the narration-last schema are the rest.

## 7. Open issues, in the order I'd take them

1. **Decide narration vs mutations emission order** (5) - one schema edit, worth 3.1 s in one run and
   6.8 s in another, so its value scales with how chatty the mutations get.
2. **Probe D**: warm-vs-cold TTFT at 12-20 K, does the DeltaNet prefix cache survive across turns.
   This single number decides whether a spoken turn can ever feel instant.
3. `--load-mode mlock` on the DM, or a 1-token warm-up request in `start-dm.ps1`, to kill the 4.3 s
   cold first turn (observed exactly once per server start).
4. **Mic topology for four players** (§3): per-slot PTT vs headsets vs one shared "whoever talks".
   Blocks the input half of the game loop, not the output half.
5. Real-table STT accuracy: everything here transcribes *synthesized* speech. Parakeet heard "Kessa" as
   "Kesser" and dropped a leading "I"; with party/member names we want a hotword/bias list (audio.cpp
   supports ASR prompts) or a post-AST name-fuzzy-match against the party sheet.
6. `dm_voice.py` is a prototype: no barge-in (micing keeps running under narration - actually it does
   run, but the DM has no notion of interrupting itself), no ducking of music, no echo cancellation
   (speaker->mic will feed back if the room is loud), and `--mic` has had only a silence-level smoke
   test since nobody was speaking into it.
7. The CUDA build is deployed for OmniVoice and worth keeping for anything diffusion-shaped. ASR and
   VAD stay on CPU (already 10-500x realtime there, and VRAM is reserved for ComfyUI/Anima). Untested on
   GPU: diarization, speaker verification, source separation and the noise-robustness frontends, all of
   which would benefit from the same card.
