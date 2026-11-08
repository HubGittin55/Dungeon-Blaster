# ComfyUI + Anima for Dungeon Blaster card art

Status: MCP wired into pi, Anima graph reproduced and rendered, 8-step turbo LoRA installed,
timings measured. **Open question: is 21 s/card acceptable, i.e. do we generate at runtime or
pre-generate?**

## 1. Topology - there is already a ComfyUI, do not install another

ComfyUI 0.44.0 is already running on this box and is the render service:

| | |
|---|---|
| endpoint | `http://127.0.0.1:8188` (`--listen 0.0.0.0`, so it is LAN-exposed) |
| install | `C:\Users\jommy\OneDrive\Documents\ComfyUI` (embedded python, models in OneDrive) |
| flags | `--windows-standalone-build --lowvram --fast --disable-partner-nodes` |
| GPU | shares the RTX 4060 with the OmniVoice narrator on :8082 |

Control comes from pi's own MCP support - no extra server, no python bridge of my own:

```
pi mcp add comfy --exposure direct --env COMFYUI_URL=http://127.0.0.1:8188 \
  -- node C:/dm/mcp/node_modules/@miller-joe/comfyui-mcp/dist/index.js --stdio --comfyui-url http://127.0.0.1:8188
```

`pi mcp list` => `comfy: connected, 15 tools (direct, global)`: generate_image,
generate_variations, **generate_with_workflow**, refine_image, upscale_image, **list_models**,
list_workflows, upload_image, generate_with_controlnet, generate_with_ip_adapter, and the
workflow-template registry (save/list/get/delete/run - the right home for the Anima graph once the
look is final). Chosen over the alternatives because it is 2 dependencies with no native build,
runs on the node 20 already installed, and its `generate_with_workflow` takes an arbitrary
Save(API Format) graph, which is what Anima needs. Tools register at session start, so a session
that was already open needs `/reload`.

`C:/dm/voice/mcp_call.py` is a 90-line stdio JSON-RPC client that calls the same server from a
shell - used to verify tools before relying on them mid-session.

## 2. The Anima graph (from the shipped blueprint, not from memory)

ComfyUI 0.44 has native Anima support (`comfy/text_encoders/anima.py`) and blueprints. The Anima
blueprint's real graph (`definitions.subgraphs[0]`, worth knowing because the outer JSON only shows
one subgraph node):

| node | config |
|---|---|
| `UNETLoader` | `anima-base-v1.0.safetensors`, weight_dtype default - **locally: `SilvermoonMix-Anima2B-Evolved-V2.3-INT8-ConvRot.safetensors`** (3.16 GB) |
| `CLIPLoader` | `qwen_3_06b_base.safetensors` (1.19 GB), type **`stable_diffusion`**, not a qwen type |
| `VAELoader` | `qwen_image_vae.safetensors` (254 MB) |
| `EmptyLatentImage` | plain 4ch node at 1024x1024, not `EmptySD3LatentImage` |
| `KSampler` | 30 steps, cfg 4.0, **er_sde**/simple, denoise 1 |
| negative | `worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, sepia` (Anima wants score_ quality tags in the positive) |

Model files all live under the OneDrive ComfyUI tree; the diffusion model is in
`models/diffusion_models/`, which is why a `CheckpointLoaderSimple` scan does not see it - searching
for "anima" in checkpoint lists is the wrong probe (`mcp_call.py`/`/object_info` must cover
UNETLoader too).

## 3. 8-step turbo

### The mix is not the 2B, and 28-block LoRAs need a patch

The checkpoint is **2.923 B params over 40 blocks** (`net.blocks.0..39`), not the stock Anima 2B's
2048-dim x 28 blocks. The `Evolved` mix grew the transformer and carries a `net.llm_adapter.*`
text-encoder tower (Qwen 0.6B adapted to 1024-dim). The official turbo LoRA is written for 28
blocks, so raw indices do not line up with a 40-block model - which is why the user wrote
**`ComfyUI-Anima-2.9B-loraPatch`** (node `AnimaLoraPatch28to40`, remaps `net.blocks.N.* ->
net.blocks.(10N+7)/10.*` + `time_embed` + `final_layer`, auto-detects the 40-block `blk_map`, and
stacks `LoraLoader` on top).

**This invalidated a conclusion I published.** My same-seed A/B said "the turbo LoRA changes nothing
measurable". With the patch applied, the identical A/B measures **detail 1479 with LoRA vs 188
without** at 768 (640: 1846 vs 384), and the eye agrees: LoRA-at-8-steps is crisp inked line art;
no-LoRA-at-8-steps is soft, dark, muddy. A silently misapplied LoRA produced a clean-looking null
result, and I believed the measurement instead of the mechanism. Two rules follow:

- Verify a LoRA is *mechanically* attached (tensor count and target names it reports) before
  concluding anything from a null result.
- A metric that moves (my Laplacian did, x5) is only as good as the hypothesis it is testing.

### The original finding about the LoRA (still true, now moot)

| file | size | note |
|---|---|---|
| `anima-turbo-lora-v0.2.safetensors` | 142 MiB, 1016 tensors | installed at `models/loras/Anima-Lora/` |
| `anima-rl-v0.1.safetensors` | 142 MiB | aesthetic RL variant, untested |
| `anima-highres-aesthetic-boost.safetensors` | 132 MiB | untested |

Gotchas found:

- `LoraLoader.lora_name` is validated **as an exact string**: `"Anima-Lora\\anima-turbo-lora-v0.2.safetensors"`
  (backslash) is accepted, the forward-slash path returns
  `400 value_not_in_list ... not in (list of length 46)`.
- A LoRA merges into INT8-ConvRot weights without complaint - quantization is not a blocker.
- The node needs the LoRA on both branches (`model` and `clip` outputs), i.e. the CLIPTextEncodes
  must consume `["10", 1]`.

## 4. Measured on the 4060 laptop, current stack

Rebuilt faithfully from the user's own `Anima-bench.json`, **640x640 / 8 steps / cfg 1 = 1.91 s median**.
My earlier graph took 4.16 s for the same pixels; the whole 2.2x gap is explained below, one variable at
a time (`replica.py`, medians of 5, fresh seed + fresh `filename_prefix` every run).

| variant vs the replica | wall | delta |
|---|---|---|
| **A. replica: cfg 1, kitchen attn, dpmpp_2m/simple, 16ch latent, LoRA 0.75** | **1.91 s** | - |
| C. fresh prompt every run (CLIP cache miss) | 2.00 s | +0.09 |
| D. `pytorch attention` instead of comfy kitchen | 2.06 s | +0.15 |
| H. no LoRA | 1.99 s | +0.08 |
| L. euler instead of dpmpp_2m | 1.92 s | +0.01 |
| M. er_sde sampler (my old default) | 1.98 s | +0.07 |
| N. 4-channel EmptyLatentImage (my old default) | 1.93 s | +0.02 |
| F. sampler only, no VAE decode / PNG save | 1.71 s | -0.20 |
| **E. cfg 3.5 instead of 1** | **3.91 s** | **+2.00 (2.05x)** |

1. **cfg above 1 doubles the cost** - CFG evaluates cond + uncond every step. This is the whole story,
   and the user's bench had cfg at 1. It is not a quality compromise: the turbo LoRA is cfg-1 native, and
   at an identical seed cfg 1 gave a painted, lit card while cfg 3.5 gave a flat cel sprite on black.
   The architecture doc's "8 to 12 steps at CFG 1" official Turbo configuration is correct on both counts.
2. **Prompt caching is worth 0.09 s of 1.91 s.** So "is the 2.1 s just caching?" - no. ComfyUI caches the
   CLIP encode and the LoRA-patched model; the sampler always runs at full cost.
3. Comfy kitchen (int8) attention is worth **0.15 s** end to end, matching the microbenchmark's ~9 %
   attention share. Real, minor, free - keep it.
4. VAE decode + PNG save is only **0.20 s**, so no preview-node trick is worth anything.

Steps are linear: 4 steps **1.22 s**, 6 steps 1.62 s, 8 steps 1.91 s, 12 steps 2.71 s
(~0.175 s/step at 640, ~0.5 s fixed). **4 steps at 640 is card-usable by eye** - same composition,
slightly softer metalwork - which softens the doc's warning about 4-step merges (this is the turbo LoRA at
4 steps, not a merge, and it did not fall apart). Resolution at cfg 1 / 8 steps: 512 1.73 s, 640 1.91 s,
768 2.78 s, 896 3.98 s.

**Game dial: 1.2 s (4 steps) to 1.9 s (8 steps) per 640 card; 768 hero art 2.78 s.** Saved as MCP template
`anima-card-640`; API-format copy in `C:/dm/comfy/anima_card_api.json`.

### Superseded numbers, and why

The first pass at this section (768 = 21-22 s, 1024 = 41.7 s, 30-step ceiling 76.5 s, "512 is distorted")
described a **45 W power envelope**, cfg 3.5-4, pytorch attention, and the misaligned LoRA. Remove the cfg
factor and the old and new tables reconcile: 21.7 s / 2.05 = 10.6 s, and driver 621 + comfy-kitchen +
no-`--lowvram` + 120 W covers the rest. "512 is distorted" was wrong too - that was the LoRA landing on
the wrong blocks; 512 renders clean today (`res512.png`, seen by eye).

### Trap: the power delivery is part of the benchmark

The laptop was previously on a supply that capped it near **45 W**; on the 240 W brick the dGPU pulls
up to ~120 W. That, plus driver 621 + torch 2.15 + comfy-kitchen + no `--lowvram`, is worth ~3.6x at
768 (21.7 s -> 6.05 s). Idles read ~55 W with clocks at 2745/3105 MHz.

This is the same class of error as the OS power plan on the DM side: the same command is a different
machine depending on what it is plugged into. Record the brick, the plan, and the clocks next to every
timing, on both the CPU and GPU halves of the project.

### Timing methodology trap

ComfyUI memoizes by graph hash. Re-running a seed/size/prefix triple returns the cached history
entry in 0.3 s, which looks like a 70x speedup; two of my early "warm" numbers were cache hits.
Any benchmark must vary seed *and* `filename_prefix`.

## 5. Sharing the card with the narrator

Anima (4.6-6.1 GB resident) and OmniVoice coexist: TTS measured RTF 0.49 warm while Anima was
loaded; the first TTS call after VRAM pressure cost 4.34 s (CUDA context re-warm). Nothing needs to
be unloaded between voice and image work, but the first voice line right after a big render is slow
- so do not put a card render immediately before a line the player is waiting on.

`--lowvram` has since been dropped from the launch line; steady VRAM is ~5.1 GB of 8 GB.

### flash-attn: dead weight, and the honest fix is to stop wanting it

Installed and broken: `flash_attn 2.7.4.post1` and `sageattention 2.2.0+cu128torch2.9.0andhigher`
are stale cu128/torch-2.9 builds; both die at `DLL load failed` importing `flash_attn_2_cuda` /
`_fused` under torch 2.15+cu134. Consequences and options, measured (`bench_attn.py`, real Anima
shapes - hidden 2048, 32 heads x 64, self-attn sequence = (px/16)^2):

| implementation | 640 (1600 tok) | 768 (2304) | 1024 (4096) | cross kv512 |
|---|---|---|---|---|
| pytorch SDPA (what runs now) | 1.07 ms | 1.42 ms | 2.02 ms | 0.36 ms |
| comfy-kitchen int8 (`--use-ck-attention`) | **0.75 ms (1.42x)** | **0.83 ms (1.70x)** | **1.28 ms (1.58x)** | 0.39 ms (0.92x) |
| SDPA shim posing as `flash_attn_func` | 1.01 ms | 1.42 ms | 2.40 ms | 0.37 ms |
| split / sub_quad legacy fallbacks | 4.93 / 3.56 ms | 8.13 / 5.72 | 12.0 / 7.9 | 1.88 / 1.24 |
| flash_attn, sageattention | import fails | import fails | import fails | import fails |

1. **Nothing needs flash_attn.** Neither it nor sageattention is imported by ComfyUI core or by any
   installed custom node; comfy only reaches for it under `--use-flash-attention`.
2. **The flag is currently fatal, not merely off.** `attention.py` does `except ImportError: if
   flash_attention_enabled(): log error; exit(-1)`, and the sage branch `raise e` when the failing
   module name is not `sageattention` - which is exactly what a half-installed wheel produces. So the
   stale wheels turn a friendly hint into a raw crash.
3. **The headroom is small.** Attention is 40 blocks x 8 steps: ~0.45 s of a 4.2 s render at 640,
   ~0.57 s of 6.05 s at 768, i.e. ~9 %. Best available replacement (kitchen int8) recovers ~3 % and
   quantizes attention. A real FA2 would land at SDPA speed - the shim above *is* SDPA and measures
   the same, and torch 2.15 already selects a FLASH-family SDPA kernel (verified working on sm89).
4. **It cannot be pip-installed on this box.** PyPI `flash-attn` is sdist-only (2.8.3.post2, no
   `win_amd64` wheels at any CUDA version); upstream release assets are Linux `.whl`/`.tar.gz`; no
   `flash-attn-win`/`-cu13` packages exist. A real build needs the **CUDA 13.4 toolkit** (only 12.8 is
   installed, and 12.8 nvcc cannot target a cu134 torch) plus VS2022 BuildTools (present) and a long
   compile, for ~0 net gain.

Recommendation: `pip uninstall flash_attn sageattention` from the embedded env, keep the default
`attention_pytorch`, and treat `--use-ck-attention` as a measured 3 % experiment, not a fix.

## 6. License - decision-relevant, read before shipping

Anima is **CircleStone Labs Non-Commercial License** (and a derivative of
Cosmos-Predict2-2B-Text2Image, so the NVIDIA Open Model License applies to derivatives):

> The model and derivatives are only usable for non-commercial purposes. ... this restriction
> applies only to the Model, and not to Outputs (the generated images). You may use generated
> images commercially.

So: **shipping generated PNGs is fine; running the model inside a paid game is a commercial use of
the model** and needs the license email (tdrussell@circlestone.ai). `SilvermoonMix-Anima-Evolved`
carries its own `license: other` - check it too. If Dungeon Blaster is going to be sold, either get
the commercial grant, or pre-generate art, or swap the runtime checkpoint for a permissively
licensed anime model (Animagine XL is Apache-2.0-ish, different architecture).

## 7. Files

| file | what |
|---|---|
| `C:/dm/comfy/anima_api.json` | the API-format graph (UNETLoader+CLIP+VAE+KSampler+SaveImage) |
| `C:/dm/comfy/anima_tool.json` | same graph wrapped as `{"workflow": ...}` for the MCP tool |
| `C:/dm/comfy/anima_turbo.py` | LoRA variant builder + settings sweep |
| `C:/dm/comfy/ab_anima.py` | fixed-seed A/B (LoRA on/off, step-count ceiling, 1024, portrait) |
| `C:/dm/comfy/probe_anima.py` | render sanity + warm timing + voice coexistence |
| `C:/dm/comfy/sweep2.py` | timing re-verify + same-seed LoRA A/B + step/cfg floors (cache-busted) |
| `C:/dm/comfy/replica.py` | **rebuild of the user's Anima-bench.json + one-variable timing decomposition** |
| `C:/dm/comfy/anima_card_api.json` | the shipping graph in API format (cfg 1, 640, 8 steps; also MCP template `anima-card-640`) |
| `C:/dm/comfy/res_ladder.py` | 512/576/640/768/896 ladder at fixed seed (`res512.png` ... `res896.png`) |
| `C:/dm/comfy/bench_attn.py` | attention backends at real Anima shapes; the flash-attn verdict |
| `C:/dm/voice/mcp_call.py` | shell MCP client (`list_models`, `generate_with_workflow @file`) |

## 8. Next

1. **Settled**: 640x640, 4-8 steps, **cfg 1**, dpmpp_2m/simple, shift 3, turbo LoRA @0.75, kitchen
   attention -> MCP template `anima-card-640` (1.91 s at 8 steps, 1.22 s at 4 steps).
2. The graph needs no loraPatch node - the 28->40 remap is a global `comfy.lora.load_lora` monkeypatch,
   so any `LoraLoader*` in any graph is remapped. The game must still vary seed + `filename_prefix` or
   ComfyUI serves a cached image in 0.3 s.
3. Runtime generation is trivially viable now: 1.2-1.9 s fits inside a spoken line. Still never
   *immediately* before a voice line - TTS pays ~4.3 s to reclaim VRAM after a render.
4. Prompt design for the game: item / portrait / environment templates with Anima's
   `score_9, score_8_up, ..., source_anime` convention + the bench negative. Note **cfg 1 ignores the
   negative entirely** - it gets encoded and never used, so per-template negatives are cosmetic until
   cfg > 1 is ever needed.
5. Uninstall the dead `flash_attn` / `sageattention` wheels (flash-attn section below).
6. Licensing decision if the game is commercial.
7. Re-measure the 30-step ceiling and portrait aspect at cfg 1 if hero art ever needs them.
