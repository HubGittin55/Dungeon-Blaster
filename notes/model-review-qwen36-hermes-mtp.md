# DM model review — `LuffyTheFox/Qwen3.6-35B-A3B-Uncensored-Genesis-Hermes-MTP-GGUF`

Reviewed against `dungeon-blaster-architecture.pdf` (Planning stage, Nov 2026), 2026-11-05.
Everything marked **[measured]** was read out of the GGUF header / llama.cpp `master` source today;
everything marked **[est]** is arithmetic on those numbers and dies at the first slice, per the
document's own rule.

---

## 0. Verdict

Take the MTP file: `Hermes3.6-35B-A3B-Uncensored-Genesis-MTP-MXFP4.gguf` (20.06 GiB) **[measured]**.
llama.cpp `master` supports this exact shape (`LLAMA_ARCH_QWEN35MOE`, `nextn_predict_layers=1`,
`--spec-type draft-mtp`) **[measured]**.

But fix one thing in the plan first: **the vendor MXFP4 quant is not an IQ4_XS-class drop-in.** In this
file only most of the routed experts are 4-bit; *everything dense is Q8_0* (and layers 0/39 keep Q8_0
experts too). That makes every token **1.34x** more expensive than the IQ4_XS build the doc's 15-21
tok/s band was computed from **[measured: 2.50 vs 1.87 GiB/token, 1.31-1.39x on this box]**. MTP does
not cancel that tax; it amortizes it. The experts are not the problem - at 8-of-256 they cost 0.52 vs
0.50 GiB/token in the two files, i.e. nothing. The whole gap is the dense path: 1.98 vs 1.37 GiB.

Two platform decisions are folded in below and are locked: **native Windows x64 for everything (no
native Windows x64**, section 3 and 6; and **MTP on** with the non-MTP file kept as the control, section 8.

Realistic bands for this file on the laptop **[measured, this box, 38-39 GB/s effective — see §9]**:

| build | GiB read per token | plain decode |
|---|---|---|
| **this file (MXFP4 + Q8_0 dense)** | **2.50** | **15.5 tok/s best / 14.5 mean** |
| base IQ4_XS (same arch, Aggressive merge) | 1.73 | **20.3 best / 20.1 mean** |
| **DIY: MXFP4 experts + Q4_K dense (built, adopted)** | **1.71** | **20.5 best / 20.4 mean** |

The two measured rows both come out at 38-39 GB/s of effective streaming, which is the honest machine
constant and the reason the estimates were too low: the doc (and I, following it) assumed 22.5-31.3. No
MTP column any more — MTP measured as a wash on this artifact (§8), so the only lever left is bytes.

So: **25 tok/s CPU-only is reachable, but only where acceptance is high** — i.e. the `resolve_round`
JSON and low-temperature turns — not for free-form narration at temp 0.75. And it is comfortably
reachable if the dense path gets lighter. Details in §2.

---

## 1. What the artifact actually is [measured from GGUF header]

```
general.architecture               qwen35moe        (llama.cpp: LLM_ARCH_QWEN35MOE)
qwen35moe.block_count              41               (40 trunk + 1 NextN/MTP block)
qwen35moe.nextn_predict_layers     1                (MTP present; absent in non-MTP file)
qwen35moe.context_length           262144
qwen35moe.embedding_length         2048
qwen35moe.attention.head_count/_kv 16 / 2,  key_length=value_length=256
qwen35moe.expert_count/_used       256 / 8 (+1 shared)
qwen35moe.full_attention_interval  4                (10 of 40 layers are softmax attention)
qwen35moe.ssm.*                    Gated DeltaNet linear attention in the other 30
tokenizer.ggml.pre                 qwen35           (old builds: tokenizer mismatch = garbled output)
tokenizer vocab                    248320           eos 248046
general.name                       "Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive"   <-- stale
```

Quant map (753 tensors, size model reproduces the file to 0.05%):

| part | params | ggml type | bpw |
|---|---|---|---|
| routed experts | 30.6 B | `MXFP4` (id 39) | 4.25 |
| routed experts (a few layers, K_P-style mix) | 2.42 B | `Q8_0` | 8.5 |
| **attention + Gated DeltaNet + shared expert** | **1.44 B** | **`Q8_0`** | **8.5** |
| `token_embd` + `output` | 1.02 B | `Q8_0` | 8.5 |
| norms / ssm_a / conv1d / gate_inp | 0.02 B | F32 / BF16 | 32 / 16 |

What MTP adds (MTP file vs non-MTP file, tensor-by-tensor diff): exactly one extra block,
`blk.40`, **at Q8_0** — `attn_q`, `attn_output`, `ffn_{gate,up,down}_exps` (all 256 experts, 856 MB)
plus `nextn.eh_proj / enorm / hnorm / shared_head_norm`. Total **+898 MB**, `block_count 40 -> 41`.
Draft cost per drafted token is ~55 MB vs the target's ~2080 MB **[est]**, so the head itself is cheap.

Repo files (only ever pull one; the repo is 131 GB):

| file | size | note |
|---|---|---|
| `...-MTP-MXFP4.gguf` | **20.06 GiB** | **ship this** |
| `...-MXFP4.gguf` | 19.23 GiB | same weights, no head -> A/B control |
| `...-MTP-Q8_K_P.gguf` | 41.45 GiB | cannot run on 32 GB. Repo's own "recommended quant" is off-table here |
| `...-Q8_K_P.gguf` | 41.45 GiB | 3.3 GiB/token, ~12 tok/s — a server file, and the **DIY requant source** (§5) |
| `mmproj-...-F16.gguf` | 0.84 GiB | vision; not in slices 1-3 |

Provenance to log, not to trust: this is a base uncensored Qwen3.6-35B-A3B (`HauhauCS`, "0/465
refusals") with (a) "Genesis" third-party tensor surgery (SVD / Marchenko-Pastur noise reduction,
self-reported, no published evals) and (b) Hermes function-calling behaviour grafted by **overwriting
~2k FFN expert tensors taken from a Qwen3.5-35B Hermes finetune** onto a Qwen3.6 model. The doc's own
identity rule ("distinct model, not an interchangeable name in configs or logs") is now load-bearing:
a cross-version tensor graft is exactly what the rule is for. The vendor scores in the doc (MMLU-Pro
85.3 / GPQA 84.2 / SWE-bench 69.2) are **base-model** numbers and do not transfer to this artifact.

License: Apache-2.0 on the repo (fine, and unlike Anima's non-commercial weights this one is clean).

---

## 2. 25 tok/s: what is actually binding

Decode on this machine is bandwidth-bound, so tok/s = effective RAM bandwidth / bytes read per token.

**Effective bandwidth on this laptop: 35-39 GB/s, and it depends on what the dense path is.** Three
measured points: Q8_0-dense MXFP4 file 2.50 GiB x 15.48 = **38.7 GB/s**; MXFP4-experts + Q4_K-dense
1.71 x 20.53 = **35.1**; IQ4_XS-everywhere 1.73 x 20.29 = **35.1**. Q8_0 dequant is a trivial widening,
K-quant and IQ dequant are real ALU work, so they stream ~10% slower. DDR5-5600 dual SODIMM peaks at
89.6 GB/s, so this box delivers ~40-43% of theory, which is normal for scattered 2 MiB-page access on
an APU box that is also driving the display. The doc's 22.5-31.3 GB/s calibration was **too low**, and
every estimate built on it inherited the error mine included: I quoted 2.08 GB/token for this file for
most of a week. The header says **2.50**.

Counting bytes properly (`notes/gguf_tokens.py`, which is the fix — hand arithmetic got this wrong
twice): a token reads *all* of the dense/attention/shared-expert path, **8/256 of the routed expert
pool**, one row of `token_embd`, and *none* of the MTP block unless the drafter runs.

| class | MXFP4 artifact | IQ4_XS artifact | read per decoded token? |
|---|---|---|---|
| EVERY (dense/attn/shared/out) | 1.94 B params = **1.98 GiB**, all Q8_0 | 1.94 B = **1.37 GiB** (IQ4_XS + Q5_K + Q6_K) | yes, entirely |
| SPARSE (256 routed experts) | 32.2 B = 16.73 GiB | 32.2 B = 15.94 GiB | only 8/256 = **0.52 / 0.50 GiB** |
| ROW (token_embd) | 0.51 B = 0.50 GiB Q8_0 | 0.51 B = 0.25 GiB | one row |
| DRAFT (MTP blk.40) | 0.84 B = **0.84 GiB** | absent | only when drafting |
| **per token** | **2.50 GiB** | **1.87 GiB** | |

Two things fall out that the file names hide. First, **the "A3B is fast on CPU" reasoning is blind to
the dense path**: "3B active" says nothing about how those 3B are stored, and here they are 8.5 bpw.
Second, **the MTP block is not a free head**: it is a whole transformer block with Q8_0 experts, so
every drafted token costs +0.84 GiB of the 38 GB/s budget before it is even accepted. That is the
other half of why MTP measured as a wash (§8) — the draft pass is expensive on a sparse MoE, and it
pays off only if acceptance is high, which on this artifact it is not (0.41-0.56).

### The MTP catch specific to sparse MoE (this is the part worth internalizing)

Speculative decoding wins when the verified batch re-reads the same weights. With 8-of-256 routing,
4 verified tokens activate ~30 distinct experts instead of 8, i.e. **expert traffic x3.8** at
`--spec-draft-n-max 3` **[est]**. The dense part amortizes 4x, the expert part barely amortizes:

```
speedup = L / (dense + experts x fanout(k+1)) / baseline_bytes

--spec-draft-n-max 3, this file (dense 1.53 GB, experts 0.55 GB, fanout 3.82):
   p=0.50  L=1.88  x1.07   12-16 tok/s
   p=0.65  L=2.35  x1.34   15-20 tok/s
   p=0.80  L=2.95  x1.69   18-25 tok/s
   p=0.90  L=3.44  x1.97   21-30 tok/s
```

Consequences, in priority order:

1. **Acceptance length is the whole game.** p is a function of entropy, not of MTP quality. Prose at
   `temperature 0.75, top_p 0.75, top_k 20` (the README's own non-thinking preset) sits near p~0.5-0.65.
   Constrained, boilerplate-heavy JSON at low temperature sits at 0.85-0.95.
2. Which means MTP pays for **exactly the part of the round the gate waits on** (`mutations` args) and
   barely for narration. Narration is audio-bottlenecked anyway (~3-4 tok/s spoken vs 15-21 tok/s
   generated), so this is a free alignment — no architecture change needed, just stop hoping MTP makes
   the DM's prose 2x faster.
3. Grammar-constrained output makes drafts land. Run `resolve_round` through
   `-j/--json-schema` (or `response_format: json_schema`) **[measured: supported]**.
4. `--spec-type draft-mtp,ngram-mod` is allowed to stack **[measured]** and n-gram drafts cost no extra
   weight traffic at all — they only raise L. Repeated inventory/item names and JSON keys are ideal.
5. Keep `--spec-draft-n-max` at 2-3 and tune, not 5+: beyond ~4 verified tokens the expert fan-out
   eats the win at mediocre p (see p=0.5 row turning negative at k=4).
6. **Do not inherit MTP speed claims from dense-model reports.** And note the head is transplanted: the
   MTP tensors come from `mudler/...-APEX-MTP-Balanced.gguf`, i.e. fit against the *unrepaired* base,
   while the target's tensors were SVD-denoised and had FFN experts overwritten. Expect a lower
   acceptance rate than an official MTP build, and measure it rather than assuming.

Cheapest latency wins, all bigger than MTP, none of them compute:

- `--reasoning off`. The shipped template defaults **`enable_thinking = true`** and
  **`auto_disable_thinking_with_tools = false`** **[measured from chat_template.jinja v21.4]**. A
  300-token think block at 13 tok/s is 23 s of dead air per round before the gate even starts. This is
  the single biggest item in the whole latency budget and it is a flag.
  (`--reasoning-budget N` exists if we ever want a capped amount of thinking.)
- `--reasoning-preserve` off: the template's `_preserve_thinking` defaults to `true`, which re-renders
  old `<think>` blocks into history and silently eats the ~8K history budget.
- Prefix cache on. Doc's KV arithmetic checks out exactly (2 KV heads x 256 x 10 layers = 20 KiB/token
  F16 -> **640 MiB @ 32K**, 5.0 GiB @ 262K) **[measured/est]**. But 30 of 40 layers are DeltaNet:
  cross-request prefix reuse needs the recurrent state snapshotted too. **Verify an actual cache hit**,
  don't verify that `cache_prompt` is on. If hybrid prefix reuse does not work, every round is a cold
  12-20K prefill and TTFT, not decode, is the whole game. Highest-value unknown in the project.
- The README's other advice is LM Studio/GPU advice and must not be copied: "recommended quant
  Q8_K_P", "keep at least 128K context to preserve thinking" (we run non-thinking; 32K stands),
  "force MoE weights onto CPU to 40 / GPU offload to maximum" (moot for a CPU-only build).
  K/V cache type F16: agreed, matches the doc.

---

## 3. RAM: fits natively, which is the whole point of running native

**Decision: everything runs native Windows x64. No Linux layer, no exception, no fallback.** Verified this is
viable for all four runtimes, and it makes the 20 GiB model comfortable:

| resident, native | GiB |
|---|---|
| MTP-MXFP4 weights (mmap'd) | 20.06 |
| KV @ 32K, F16 | 0.63 |
| DeltaNet state (30 layers) + MTP ctx + compute buffers | ~0.4-0.8 [est] |
| OmniVoice GGUF Q8 (audio.cpp) | ~1.2 |
| Pi (Node 22) + ComfyUI python_embeded + tracker | ~0.8-1.2 |
| Windows 11 desktop + DWM + antimalware | 4-6 |
| game client | ~2, **to be measured in Slice 1** |
| **total** | **~28-30 of 32** |

Native is what makes this table fit at all: no hypervisor balloon, no "defaults to 50% of RAM =
16 GB" trap inherited from a VM layer, no second page-cache, and no 20 GiB of model living
inside a VM that Windows can trim under pressure. Keep `--mmap` (llama.cpp default) so the NTFS cache
absorbs pressure instead of the process dying mid-round, and leave the pagefile system-managed on C:.

Keep the 9B-Q5 fallback page, but it moves from "if the 35B proves heavy" to "the documented escape
hatch": MXFP4 is the only small-enough quant this artifact ships, so there is no IQ4_XS to retreat to
inside the repo (see the DIY requant path in §5).

Doc bug while we are here: weights are quoted in mixed units — "IQ4_XS ~17.7 GB" is GiB, "Q4_K_M
~21.3 GB" is decimal GB. Real files: IQ4_XS 17.44 GiB, Q4_K_M 19.71 GiB, this file 20.06 GiB. Budget in
GiB.

---

## 4. Turn contract changes (bigger than the speed question)

1. **The community template is NOT embedded in the GGUF.** GGUF-embedded template = 7,764 chars
   (stock-ish Qwen3.6/Hermes-XML). Shipped `chat_template.jinja` = 16,301 chars,
   `template_version "qwen3.6-froggeric-qweefchief-v21.4"` **[measured]**. It is a different turn
   contract (adds `<|think_off|>`/`<|think_on|>` control tokens, `tool_call_format`,
   `max_tool_arg_chars`, injected retry warnings). llama.cpp otherwise uses the embedded one.
   -> Vendor the file into the repo (already at `notes/chat_template.jinja`), pass
   `--chat-template-file` explicitly, hash it, and log the hash + `-rea` state in `TurnLog` next to
   `rules_hash`. The README even points at a *different repo's* template, so "latest" is not a config.
2. **Tool calls are XML/Hermes, not OpenAI-native `tool_calls`.** Default `tool_call_format = 'xml'`:
   `<tool_call><function=name><parameter=k>value</parameter>...`. llama.cpp auto-derives a parser from
   the Jinja template (`common/chat-auto-parser`, `common/parsers/qwen3-coder.cpp`) **[measured]**,
   which only works if the right template is loaded (`--jinja`).
3. **Use grammar, not faith, for key order.** The doc's "mutations first, narration last, gate when the
   array closes" needs emitted key order. `-j/--json-schema` (server: `response_format: json_schema`)
   makes the grammar emit keys in schema order, guarantees parseable args, guarantees a
   `resolve_round` call, and lets empty `mutations: []` mean "pure narration". That collapses the
   two-pass-fallback decision in Slice 1 to a measurement instead of a hope. Test it *with* MTP:
   grammar + speculative verification on the same slot is young code.
4. Rejection payloads go back as `role: tool`. The template renders them as
   `<tool_response>` inside a user turn, and **injects its own "SYSTEM WARNING: N consecutive tool
   errors"** after 1 and 2 content-sniffed failures (it greps the first 80 chars for `"error":`,
   `failed to`, etc.) **[measured]**. Our per-mutation rejection payload therefore silently changes
   shape on retry rounds. Decide deliberately: either lean on it (free retry pressure) or word
   rejections to avoid it — and log which happened, since it changes the token stream.
5. `# Tools` is serialized as `tool | tojson` into a system block ahead of the persona
   **[measured]**. Emit the `resolve_round` schema with fixed key order and fixed order of tools, or
   the "static prefix" is not byte-stable and the prefix cache silently dies every round.
6. `max_tool_arg_chars` / `max_tool_response_chars` are available and default to 0 **[measured]** —
   a ready-made clamp for hostile free-text item names, cheaper than a new mechanism.
7. Vision is real but keep it out of slices 1-3: `image-text-to-text`, mmproj 0.84 GiB. Attractive
   later, as an open decision rather than architecture: on `asset_ready`, feed the generated item art
   back so the DM describes the thing it actually drew (template rejects images in system messages, so
   it must ride a user turn). Costs GPU burst time shared with Anima.

---

## 5. The 25 tok/s path (do these in order)

1. Slice 1 on **this file, MTP off** as decided; measure real GB/s, acceptance length, TTFT warm/cold.
   GB/s is now known (38-39, §9); acceptance is measured (0.41-0.56, §8); TTFT is still open.
2. Ask the author for a small quant of the same artifact (they clearly have the pipeline: the base repo
   ships IQ4_NL / IQ4_XS / Q4_K_M / Q4_K_P, and Genesis is a GGUF-space transform). Ask specifically
   for **MXFP4-or-IQ4 experts + Q4_K/Q5_K dense**, i.e. keep the repair, drop the Q8_0 dense tax. Still
   worth asking; no longer the critical path, because:
3. **DIY requant — in flight, and this is the actual recipe.** Source is the repo's own
   `Hermes3.6-35B-A3B-Uncensored-Genesis-MTP-Q8_K_P.gguf` = **41.45 GiB** (the "40.61 GiB" I had here
   was wrong), whose header reads: experts 25.23 B params @ Q8_0 + **6.98 B @ F16**, dense 1.75 B @
   Q8_0 + 0.17 B @ F16, i.e. **3.31 GiB/token, ~12 tok/s — a server file, and a clean first-quantization
   source**. Not a chained low-bit requant, so `--allow-requantize`'s quality warning does not really
   apply: everything we touch goes 8.5/16 bpw -> ~4.9 bpw once.

   ```
   llama-quantize.exe --allow-requantize `
     --tensor-type 'ffn_.*_exps\.weight=MXFP4' `
     --output-tensor-type Q6_K --token-embedding-type Q6_K `
     <in>-MTP-Q8_K_P.gguf  <out>-MTP-MXFP4-Q4_K_S.gguf  Q4_K_S  14
   ```

   Why that shape: `Q4_K_S` for the base puts the **EVERY class** (the 1.94 B params every single token
   reads) from 1.98 GiB to ~1.1 GiB, which is the entire win; `--tensor-type` puts the routed experts
   back to MXFP4 4.25 bpw so the *sparse* pool does not grow (base Q4_K would make experts 4.875 bpw,
   bigger and slower than what ships today) **and** catches layers 0/39, which the vendor left at Q8_0
   (§9.5). `Q6_K` on output/token_embd matches what the IQ4_XS artifact does for the logits path.
   MTP stays off, so letting blk.40 quantize down is free.

   Predicted from the header, at the measured 38.5 GB/s: **~1.70 GiB/token -> ~22-23 tok/s** plain,
   ~18-19 GiB file. Sanity check on the estimate: the same calculator called 1.34x for the
   MXFP4-vs-IQ4_XS pair and measurement said 1.31-1.39x.
   Gate it on `--dry-run` first (it prints the per-tensor type map without writing 18 GiB), and note
   `--tensor-type` needs a name `ggml_type_from_name` knows: try `MXFP4`, fall back to `MXFP4_MOE`
   (that is the name in `llama-quantize --help`'s target list).
4. If none of that lands: the doc's fallback (Qwen 3.5 9B Q5) is the honest answer, and MTP is not the
   reason it isn't.

---

## 6. Pinned binaries and the server invocation (native Windows)

Pinned and verified available today, all with first-class Windows x64 artifacts:

| component | pinned artifact | note |
|---|---|---|
| llama.cpp | `llama-b12144-bin-win-cpu-x64.zip` (25 MB, has `llama-server.exe`, `llama-bench.exe`, `llama-quantize.exe`) | official CPU-only Windows build; `llama-b12144-bin-win-vulkan-x64.zip` is the no-CUDA-toolkit escape hatch if we ever offload |
| audio.cpp | `audio-v0.9.4-bin-windows-x64-cpu.zip` (32 MB) | README: "Runs on Windows, Linux, macOS"; Windows x64 = CPU/Vulkan/CUDA(12.4/13.3); `omnivoice` is a supported TTS family (GGUF 16/Q8, streaming); MSVC build path is `scripts\build_windows.ps1` |
| ComfyUI | **already installed**: `C:\Users\jommy\OneDrive\Documents\ComfyUI` (windows_portable, ComfyUI **0.44.0**, `python_embeded` 3.11.6, `run_nvidia_gpu.bat -> --windows-standalone-build --lowvram --fast --use-flash-attention`) | `--lowvram` is already the right call for an 8 GB card time-shared with the client; no MCP node installed yet, so expose it to Pi as an external MCP/HTTP bridge, not a custom node |
| Pi | native (`powershell -c "irm https://pi.dev/install.ps1 | iex"`, Node 22.19+) | this session is already running native Windows |

```powershell
# D:\dungeon-blaster or C:\dm - must NOT be inside OneDrive (see section 8)
$ErrorActionPreference = 'Stop'
Start-Process -FilePath 'C:\dm\bin\llama\llama-server.exe' -WindowStyle Hidden -PassThru `
  -RedirectStandardError 'C:\dm\logs\llama.log' -ArgumentList @(
    '-m',       'C:\dm\models\Hermes3.6-35B-A3B-Uncensored-Genesis-MTP-MXFP4.gguf',
    '--chat-template-file', 'C:\dm\models\chat_template.jinja', '--jinja',
    '--reasoning', 'off', '--no-reasoning-preserve',
    '-c', '32768', '-np', '1',
    '--cache-type-k', 'f16', '--cache-type-v', 'f16', '--cache-reuse', '8192',
    '-fa', 'on',
    '--spec-type', 'draft-mtp,ngram-mod', '--spec-draft-n-max', '3', '--spec-draft-p-min', '0.15',
    '-t', '14', '--cpu-range', '2-15', '--cpu-strict', '1',
    '--no-webui', '--host', '127.0.0.1', '--port', '8080')
# per request, not per server: tools=[resolve_round] + response_format json_schema (forces key order)
# sampling (README non-thinking preset): temp 0.75 top_p 0.75 top_k 20 min_p 0.05 seed 42,
#   presence/repeat penalty off. Use temp <= 0.35 for the mutations-only phase if split.
```

Windows-specific obligations that replace the old memory-ceiling bullet:

- **Antimalware exclusion** for the model dir, the asset cache and the tracker DB
  (`Add-MpPreference -ExclusionPath`, admin). Without it, a 20 GiB mmap'd file and every PNG ComfyUI
  writes get scanned. Probe G in `notes/bench_dm.ps1` measures the difference.
- **Power**: laptop on AC, `powercfg /setactive` a high-performance/AMD Ryzen plan, minimum processor
  state 100%, disable USB selective suspend (PTT gamepads), PCI-E link power off, and keep the machine
  awake during play with `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)`
  from the launcher - Modern Standby eating a session mid-round is a Windows-only failure mode.
- **Windows Update** active hours during play sessions; the doc's "resident for the whole session"
  process table assumed a machine that never reboots underneath you.
- **`localhost` resolves to `::1` first on Windows.** Everything binds and connects with the literal
  `127.0.0.1`; a client pointing at `localhost` against a v4-only bind is a connection refused that
  looks like the DM being down.
- **MCP servers launched as npm `.cmd` shims need `shell: true`** (Node throws `EINVAL` otherwise), and
  `python3` does not exist here - only `python` / `py -3`. Both of these are Windows-only ways to lose
  a runtime with a confusing error.
- **Long paths**: enable `LongPathsEnabled` or keep the asset cache shallow; deep campaign/character
  trees will eventually cross 260 chars.
- One toolchain for builds if ever needed: VS Build Tools 2022 (C++ desktop + CMake + Ninja) or MSYS2
  MinGW-w64 if probe A shows the MSVC prebuilt is missing the repack paths.

Flags to re-verify against the pinned build (`llama-server --version`, record in `TurnLog`):
`--spec-type draft-mtp`, `--reasoning`, `--no-reasoning-preserve`, `--cache-reuse`,
`--chat-template-file`, `-j`. Some names have churned twice this year.

---

## 7. Doc diffs (page by page)

| page | change |
|---|---|
| Model identity note | Qwen3.5-35B-A3B -> **Qwen3.6-35B-A3B**, and add the full artifact id: repo + filename + sha256/16 + template hash + llama.cpp version. `general.name` inside the GGUF is stale (says the base model), so the file cannot self-identify. |
| Vendor scores row | mark MMLU-Pro/GPQA/SWE-bench as **base-model, unverified on this artifact**; add "tool-call reliability measured on this artifact in Slice 1 (evil-bot suite)". |
| Expected DM speed | replace "15-21 tok/s" with the §2/§9 numbers: **15.5 tok/s measured for the vendor MXFP4 build at 2.50 GiB/token**, 20.3 for an IQ4_XS build of the same arch, and **38-39 GB/s measured effective bandwidth** as the machine constant. State that the gap is a quant artifact (Q8_0 dense path), not a model property, and that MTP is off on this artifact (acceptance 0.41-0.56) so the doc's "x1.6 with MTP" column does not transfer. |
| Round loop / Prompt contract | add: thinking off, `json_schema`-forced key order, template vendored+hashed, retry-warning behaviour, deterministic tool serialization. |
| Voice page | bark bank now covers a *shorter* gap once thinking is off (state both numbers); narration tok/s budget unchanged, still audio-bound. |
| Risks | add: hybrid DeltaNet prefix-cache reuse unverified; MTP head transplanted from a different quant of the unrepaired base (acceptance unknown); MXFP4 CPU path young; template drift across repo updates (pin by commit SHA — this repo's files do get replaced); over-compliance of an uncensored model makes the tracker gate load-bearing; game client RAM vs `memory=28GB`. |
| Memory budgets | GiB everywhere; weights 20.06 GiB; **delete the VM memory-ceiling callout entirely**; replace with the native budget table in section 3, client RAM measured in Slice 1. |
| Environment page | rewrite as native Windows x64: pinned binaries table (section 6), no "Ubuntu for all builds", no "build llama.cpp from source in a Linux layer"; the Ada/`sm_89` note survives and is now easier (win-vulkan / win-cuda builds exist) |
| Four-runtimes table | "Runs on" column: `CPU, <old layer>` -> `CPU, native Windows` for llama-server and audio.cpp; `GPU bursts, <old layer>` -> `GPU bursts, native Windows` for ComfyUI |
| Process layout | "Start" column: systemd/session start -> one PowerShell launcher (or Task Scheduler) that starts all four, keeps the machine awake, and puts the children in a Job Object so they die together |
| First-run checklist | drop the VM memory check; add: Defender exclusion on/off timing, REPACK/SIMD line from the server log, sleep/hibernate disabled, tracker DB + asset cache outside OneDrive, disk free-space check. Then the seven probes A-G in `notes/bench_dm.ps1`, including `--spec-synth-len` (synthetic acceptance) to measure the MTP ceiling separately from the head's acceptance rate. |
| Risks | add: OneDrive hydrating/dehydrating model and asset files (it also uploads them); DWM reserving ~0.5-1 GiB of the 8 GB card while Anima wants 5.6; WDDM spill to system RAM stalling an Anima burst; single 1 TB disk at 90% full; Windows Update / Modern Standby interrupting a session. |
| Open decisions | add: MXFP4 vs DIY Q4_K_S dense; MTP on/off as a runtime A/B switch (one 898 MB flag day, keep the non-MTP file as control); art-grounded narration via mmproj (vision) as a post-slice-4 idea. |

---

## 8. Locked decisions + machine facts (this session)

**Locked**

1. DM model: **`Hermes3.6-35B-A3B-MTP-MXFP4exp-Q4K_S.gguf` (18.25 GiB) — the DIY requant, adopted**
   (§9.6): 20.5 tok/s vs 15.5 for the vendor file, +1.7% PPL inside the confidence interval, 20/20 on
   the `resolve_round` contract. Qwen3.6-35B-A3B base, MoE 256/8+1, hybrid Gated DeltaNet + 10 softmax
   attention layers, MTP head present (quantized down, unused). The vendor artifact
   `Hermes3.6-35B-A3B-Uncensored-Genesis-MTP-MXFP4.gguf` (20.06 GiB) stays on disk as the A/B control
   and as the thing to fall back to if a requant artifact is ever suspected.
2. **MTP OFF** (`--spec-type none`). Measured on the vendor file: acceptance 0.41-0.56, mean_len 2.2-2.7
   at n-max 2-3, which on a 8-of-256 sparse MoE is a wash or a loss because the draft pass pays 0.84 GiB
   of expert fan-out per drafted token. **Re-measured on the requant, which is the condition this
   decision deferred to** (draft block's experts now 4.25 bpw, so 0.42 GiB instead of 0.84): acceptance
   0.50-0.67, mean_len 2.0-2.34, throughput **16.9-18.8 tok/s vs 20.4 with the drafter off** — still a
   10-17% loss, because the acceptance *length* never moved even though the draft got cheaper. OFF
   stands, now on the artifact we actually ship. The rule of thumb survives too: mean_len has to clear
   ~2.6 and the head only ever reaches ~2.3 at n-max 2 on this base model.
3. **Thinking off** (`--reasoning off`, `--no-reasoning-preserve`). Non-negotiable: the template's
   defaults are thinking on and preserved, which is tens of seconds of dead air per round.
4. Turn contract: `resolve_round` emitted under `response_format: json_schema` so key order is enforced
   by the grammar, with the vendored `notes/chat_template.jinja` passed explicitly and hashed.
5. **Native Windows x64 only. Nothing on Linux.** Pi, llama-server, audio.cpp and ComfyUI all have
   official Windows x64 artifacts (verified), so the doc's Linux pages get deleted, not annotated.
6. Never download the repo (131 GB). Pull one file, pinned by commit SHA: this repo's files do get
   replaced under the same names (last modified today).
7. The doc's vendor capability scores are base-model numbers; tool-call reliability gets measured on
   this artifact by Slice 1's evil-bot suite.

**Machine facts, as measured today**

- Single volume: `C:` 953 GB. Was 90% full at the start of this session; after cleanup and pulling
  three 17-41 GiB GGUFs it sits at **~138 GB free**. The §5 DIY requant (41.45 GiB Q8_K_P source +
  ~18 GiB output) fits, but it is now the largest thing on the volume — if anything else wants 40 GB,
  delete the IQ4_XS probe file first (it has already answered its one question).
- Models live at `C:\dm\models` (outside OneDrive, per below); `C:\dm\bin` holds the pinned binaries.
- Keep the pagefile system-managed on C:, which lives in that same 103 GB.
- ComfyUI: `C:\Users\jommy\OneDrive\Documents\ComfyUI`, windows_portable, **0.44.0**, python_embeded
  3.11.6, ~44 GB of models under `ComfyUI\models` (checkpoints 28 GB), `custom_nodes` populated
  (Manager, Impact-Pack, controlnet_aux, IPAdapter, rgthree, was-suite...), **no MCP node installed**.
  Output dir ~1.1 GB / 27 files.
- Models, loras and the KoboldCPP model dir are also reached through the same symlink-in-OneDrive habit
  (`ComfyUI\models\llm_gguf -> ..\..\KoboldCPP\Model`).
- Consequence, and it is cheap to fix now: **put the DM weights, the asset cache and the tracker SQLite
  outside `OneDrive\Documents`** (`C:\dm\models`, `C:\dm\assets`, `C:\dm\db`). Inside OneDrive, a 20 GiB
  GGUF gets uploaded, a PNG per generated asset gets uploaded, SQLite WAL gets its files swapped under
  it, and "free up space" can dehydrate a model you are about to mmap. ComfyUI itself can stay where it
  is; it runs. `extra_model_paths.yaml` already exists there for pointing at other model roots.

## 9. Measurements log (this box, native Windows)

Conditions for every number below: **Windows power plan = "Performance"** (the "Quiet" plan throttles
the 8840HS hard enough to change tok/s, so a benchmark taken on it is not reproducible), `-t 14`,
`-ngl 0`, `--no-repack`, `--spec-type none`, `--reasoning off --no-reasoning-preserve`, nothing else
running, `measure_once.py` = 4 identical 160-token generations against the live server.

| artifact | GiB/token | run | best | mean | implied GB/s |
|---|---|---|---|---|---|
| MXFP4 (shipping) | 2.50 | warm, right after load | **15.48** | 14.53 | 38.7 |
| IQ4_XS (Aggressive base) | 1.87 | warm | **20.29** | 19.11 | 37.9 |
| IQ4_XS (Aggressive base) | 1.87 | after 20 GiB of cache churn | **20.27** | 20.14 | 37.9 |
| MXFP4 + `--repack` (default) | 2.50 | warm | 15.43 | — | 38.6 |

**What this settles.**

1. **MXFP4 is not faster than IQ4_XS. It is 1.31-1.39x slower**, and the entire gap is the Q8_0 dense
   path. Both artifacts stream at 38-39 GB/s, so neither is limited by its kernel quality or its
   repack path — they are both pinned to the same memory wall and the only variable is bytes.
2. **The machine constant is ~38.5 GB/s.** With that one number, `gguf_tokens.py` predicts decode for
   any quant in this architecture from its header alone, no download required. Prediction vs measured
   for the pair: 1.34x predicted, 1.31x (best) and 1.39x (mean) measured.
3. **`--repack` is free of speed benefit and costs 13 GiB of RSS** (25.5 -> 12.2 GiB working set,
   18.4 -> 1.6 GiB private). Decode is bandwidth-bound, repack buys arithmetic. Always `--no-repack`.
4. **Warm vs cold page cache is a non-factor *while RAM is free*.** Streaming 20.06 GiB of a different
   GGUF through the cache at 1.69 GB/s (NVMe speed, so it genuinely came off disk) moved IQ4_XS decode
   by 0.1%: 20.29 -> 20.27 best, and tightened the mean (19.11 -> 20.14). The mapped weights stayed
   resident because 15.6 GiB of RAM was still free, i.e. there was no pressure to evict against.
   **So the real risk is not cache age, it is RAM pressure** — the cliff appears when ComfyUI plus the
   game client plus the audio server push available RAM below the model footprint and Windows starts
   trimming mapped pages. That is the four-runtime co-presence test, still open, and it is now the
   highest-value remaining measurement. Budget check: 17-20 GiB model + ~0.5 GiB audio + a SDXL
   checkpoint resident + client + Windows is uncomfortably close to 31.2 GiB, which is a second,
   independent argument for the smaller-per-token requant beyond raw tok/s.
5. **Layers 0, 39 and 40 keep Q8_0 routed experts** (9 tensors, 2.42 B params, 2.39 GiB = 12% of the
   file) while layers 1-38 use MXFP4. Fine as a quality choice, but it means the file is neither
   "4-bit" nor uniform, and in the requant those tensors are worth re-pointing at MXFP4 with
   `--tensor-type` for ~0.05 GiB/token.

**Tools added.** `notes/gguf_tokens.py` (header -> GiB/token by access class; needs `type_enum.json`,
dumped from `ggml.h` at the binary's exact commit — do not trust remembered enum values, mine were
wrong and the file-name-to-type intuition is worse). `C:\dm\bench\bench_cold.ps1` (cache-charm
measure). `C:\dm\bench\parsecheck.ps1` (parse-checks a .ps1 without running it — `bench_dm.ps1`
shipped with a quoting error that only blew up on a probe I had not re-run, which is what
`-Probes` vs `-Probe` looks like from the outside).

## 9.6 The DIY requant — built, measured, adopted

Built from the repo's own Q8_K_P with the §5 recipe (`C:\dm\bench\requant.ps1`; **3 minutes** on 14
threads, not the hour I budgeted — `--dry-run` first, which is what made 3 minutes safe). Output
18,392.91 MiB (17.97 GiB) at llama-quantize's own 4.35 BPW against the source's 10.02, exactly what the
planner predicted. `--tensor-type 'ffn_.*_exps\.weight=MXFP4'` is accepted by name (so layers 0/39's
Q8_0 experts came down to 4.25 bpw with the rest) and the shared expert correctly went to `q4_K` with
the other dense weights.

| | vendor MXFP4 | **DIY requant** | IQ4_XS probe |
|---|---|---|---|
| file on disk (`ls`, not a header sum) | 20.06 GiB | **17.97 GiB** | 17.44 GiB |
| GiB / token | 2.50 | **1.71** | 1.73 |
| decode best / mean | 15.48 / 14.53 | **20.53 / 20.41** | 20.29 / 20.14 |
| implied effective BW | 38.7 GB/s | **35.1 GB/s** | 35.1 GB/s |
| PPL, 31 KB domain corpus | **4.3263 ± 0.182** | **4.4015 ± 0.187** | — |
| `resolve_round` json_schema | 20/20, order 20/20 | **20/20, order 20/20** | — |

**Four things this settled.**

1. **The bandwidth model survives contact with a second data point, and then some.** Two artifacts built
   by completely different schemes (IQ4_XS everywhere vs MXFP4 experts + Q4_K dense) with per-token
   footprints of 1.73 and 1.71 GiB came out at 20.29 and 20.53 tok/s — 1% apart. Bytes per token is the
   whole story for this architecture on this machine.
2. **My 1.46x speedup prediction was 10% too optimistic (1.33x measured), and the reason is knowable:**
   effective bandwidth is not one constant. A Q8_0-dense file streams at 38.7 GB/s because Q8_0 dequant
   is a trivial widening; K-quant/IQ-heavy dense paths land at 35.1 GB/s because the dequant is real
   ALU work. Use 38.7 for Q8-ish dense and 35.1 for K-quant dense; the ratio still predicts.
3. **The requant cost +1.73% PPL, which is inside its own error bar.** Same-tokenizer, same-corpus,
   same-flags A/B with `llama-perplexity --chunks 12` on 31 KB of the vendor's own system prompts plus
   the project spec — a bad requant shows up here as +5-20%, not +1.7%. Honest caveat: that corpus is
   narrow prose, so it detects gross damage, not subtle reasoning regressions. The evil-bot suite (§8.7)
   is what actually certifies tool-call behavior, and it now has to run against the requant.
4. **MTP stays off, and now that is measured on the shipping artifact instead of inherited.** The
   requant halved the draft block to 0.42 GiB/token, which is the exact condition §8.2 deferred to.
   Acceptance rose a little (0.50-0.67 vs 0.41-0.56) but acceptance *length* did not (2.0-2.34), and
   throughput landed at 16.9-18.8 tok/s against 20.4 with `--spec-type none`. Full numbers in §8.2.

**Two corrections to numbers I published earlier in this document**, both from the same root cause — my
`gguf_tokens.py` bits-per-weight table had folklore values for the K-quants (`Q6_K: 8.50` !?). Exact
block ratios: Q4_K = 144 B/256 w = 4.50, Q5_K = 176/256 = 5.50, Q6_K = 210/256 = 6.5625, Q2_K = 3.28125.
Effect: the IQ4_XS reference file is **1.73 GiB/token, not 1.87** (its Q6_K output tensor was counted at
8.5 bpw instead of 6.56), which is what makes the IQ4_XS and requant arms agree instead of looking 10%
apart. The vendor MXFP4 figure (2.50) is unaffected because that file's dense path is all Q8_0.
`gguf_tokens.py` now carries the exact ratios and says so in a comment, because this is the second
arithmetic error in a row that came from hand-maintained constants instead of a source of truth.
