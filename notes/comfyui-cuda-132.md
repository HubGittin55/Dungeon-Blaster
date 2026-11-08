# ComfyUI on CUDA 13.2 — plan, with the guesswork removed

Everything below was read off this box on the same night as the DM benchmark work
(`notes/model-review-qwen36-hermes-mtp.md` §9). No number here came from a forum.

## What is actually installed (measured)

| component | version | note |
|---|---|---|
| GPU | RTX 4060 Laptop, 8188 MiB, **sm_89**, 55 W cap | not the 780M — the doc's "Anima runs on the iGPU" premise is stale |
| driver | 592.00, `nvidia-smi` reports **CUDA Version 13.1** | kernel-mode driver, version-pinned by NVIDIA to a CUDA 13.x line |
| torch | `2.9.1+cu128`, arch list `sm_70,75,80,86,90,100,120` | no `sm_89` binary — runs Ada via `sm_86` compat, which is fine (same major) |
| torchvision / torchaudio | `0.24.1+cu128` / `2.9.1` | |
| **comfy_kitchen** | **0.2.41** (latest on PyPI) | CUDA backend `_C.pyd` imports `cublasLt64_13.dll` → **it is a CUDA 13 build** |
| flash_attn | `2.7.4.post1+cu126torch2.9`, installed from a **hand-downloaded wheel** in `Downloads\` | not from an index; will not survive a torch bump intact |
| sageattention | `2.2.0+cu128torch2.9.0andhigher` (woct0rdho prebuilt) | same story, and it competes with comfy_kitchen for the same job |
| xformers | `0.0.33.post1` | |
| triton-windows | `3.5.1.post21` | |
| ComfyUI | 0.44.0, frontend 1.58.5, python_embeded 3.11.6 | requirements.txt pins bare `torch`, so no version fight |

## You were right about xformers and Triton — and the risk of removing them is near zero

- `comfy/model_management.py` wraps the xformers import in `try: ... except: XFORMERS_IS_AVAILABLE =
  False`. A stale xformers after a torch bump cannot crash startup; it just goes unused.
- `comfy/ldm/modules/attention.py` guards flash_attn the same way (`FLASH_ATTENTION_IS_AVAILABLE =
  False` + `try: from flash_attn import flash_attn_func`). The remaining flash_attn importers are
  `comfy/ldm/genmo/*` (Mochi video) and `comfy/ldm/pixart/blocks.py` — not SDXL, not Flux, not
  Z-Image. Core attention is comfy_kitchen / torch SDPA.
- `comfy/cli_args.py` only exposes `--enable-triton-backend` / `--disable-triton-backend` for
  comfy-kitchen. Triton is an *optional backend of comfy_kitchen*, not a ComfyUI dependency:
  `backends.triton` exists (int8/fp8/nvfp4 quantize + rope kernels) and is off unless enabled.

**So: uninstalling xformers + triton-windows + flash_attn + sageattention is the correct prep for the
torch bump, and the only thing it can break is Mochi/PixAttention-era accessory paths, which fall back
to SDPA rather than error.** The 8 GB card is the beneficiary: those four wheels are ~3.5 GB of
`site-packages` and, more importantly, of CUDA-graph/cublasLt warm-up work at startup.

## What is *not* broken: comfy_kitchen's CUDA kernels are already live

Probed against the 4060 with the current env:

```
sol_attn_is_available                    -> True
flash_attention_decode_is_available      -> True
int8_attention_is_available              -> True
gated_delta_decode_is_available          -> True
backends: eager, cuda, ascend(no torch_npu), hip(no ROCm), triton
list_backends()['cuda'] -> available: True, disabled: False,
                capabilities: sol_attn, window_attention, fp16_linear, int8_linear, scaled_mm_nvfp4,
                quantize_*/dequantize_* (int8/mxfp8/nvfp4/w4a4/w4a8), rms_rope*, na3d, mesh ops...
ck.fp16_linear(...) on cuda:0            -> OK
```

`cuda.fp16_linear` is a cuBLASLt user and it runs, so the `cublasLt64_13.dll` dependency resolves even
though `python_embeded` only ships `cublasLt64_12.dll` (it is resolved through the driver's CUDA 13.1
user-mode libraries, not through torch's bundled ones). This is the important consequence:

> **CUDA 13.2 buys ComfyUI almost nothing on this card.** The kernels you actually want are already
> running on CUDA 13.0/13.1 libraries. The realistic gain from a 13.2 toolkit is cuBLASLt heuristic
> churn and a newer compiler — possibly negative on a 55 W Ada part. The realistic *cost* is six minor
> versions of torch API drift against was-suite / IPAdapter / Impact-Pack / controlnet_aux, all of
> which poke at torch internals.

That does not mean don't do it. It means do it in a copy, and decide on measured `s/it` for one SDXL
and one Flux workflow, not on a version number.

## The driver question: ANSWERED, no download needed

Measured in a throwaway venv (`C:\dm\probe\t132`, system python 3.11.9 = same cp311 ABI as
`python_embeded`), installing `torch==2.14.1+cu132` and running real GPU work on driver 592.00:

```
torch       : 2.14.1+cu132 | built against CUDA 13.2
cuda avail  : True
device      : NVIDIA GeForce RTX 4060 Laptop GPU   capability (8, 9)   VRAM 8187 MiB
arch list   : ['sm_75', 'sm_80', 'sm_86', 'sm_90', 'sm_100', 'sm_120']
matmul      : OK (50x fp16 2048^3 through cublasLt)
sdpa        : OK
VERDICT     : cu132 runs on the current driver - no driver download needed
```

So CUDA's minor-version-compatibility promise holds here: **a 13.2-built torch runs on a 13.1 driver.
Skip the driver download.** Two side notes from the same output: `sm_89` is still not in any wheel's
arch list (Ada runs on the `sm_86` binary, same major, fine), and 2.14 **dropped `sm_70`** which 2.9.1
had — irrelevant unless you ever touch a V100/Tesla.

The driver only becomes a real requirement if something needs a 13.2-only *feature*, or if you want
`nvidia-smi`'s banner to stop saying 13.1 for tidiness. Reproduce with:
`C:\dm\probe\t132\Scripts\python.exe C:\dm\probe\probe_cu132.py`.

Available wheels (queried with
`pip index versions torch -i https://download.pytorch.org/whl/<flavor>`):

```
cu130: 2.9.0, 2.9.1, 2.10.0, 2.11.0, 2.12.0, 2.12.1, 2.13.0, 2.14.0, 2.14.1   <- 2.9.1+cu130 exists
cu132: 2.12.0, 2.12.1, 2.13.0, 2.14.0, 2.14.1, 2.15.0
```

Two clean paths, and the first one is nearly free:

**Path A — same torch, CUDA 13. `pip install torch==2.9.1+cu130 torchvision==0.24.1+cu130`.**
Identical API surface, so custom nodes cannot drift, and it puts torch on the same CUDA 13 line
comfy_kitchen was built for. If the goal is "stop straddling CUDA 12 and 13", this achieves it in one
command with ~zero risk. (Driver: 592.00 already ≥ the cu130 baseline, no download.)

**Path B — what you asked for, CUDA 13.2. `torch==2.14.1+cu132`** (not 2.15.0: take the second-newest,
2.15.0 is two weeks old and the Windows wheel is where the build breakage shows up first).
**Now measured to work on the existing driver**, so this path has no driver step at all.

Sequence I'd run, in this order, all reversible:

1. `python -m pip freeze > C:\dm\bench\comfyui-freeze-cu128.txt` — **as documentation, not as an
   installable file**: the portable ships `accelerate`/`torchsde` as `@ file:///D:/a/ComfyUI/...`,
   paths that exist only on ComfyUI's build machine, so `pip install -r` on it will fail. Keep it to
   diff against, and hand-write the real requirements from it.
2. Copy `python_embeded` → `python_embeded_cu128` (≈13 GB, 138 GB free on C:) and add a
   `run_comfyui_cu128.bat` pointing at it. This is the whole rollback story, and it is the only step
   that costs disk.
3. ~~Probe before touching it~~ **done, see the driver answer above**: cu132 works on 592.00.
4. In the copy: uninstall `xformers triton-windows flash_attn sageattention`, install the new torch +
   matching torchvision, then `pip install -r requirements.txt` to let ComfyUI pull what it wants.
5. Launch, and read the backend table again (`list_backends()`), plus one SDXL and one Flux run at the
   resolution you actually use. Compare `s/it` and peak VRAM against the same workflows on the old env.
   Both matter: comfy_kitchen's int8/nvfp4 paths can *raise* peak VRAM by keeping extra dequant
   scratch, and 8 GB is the tight constraint on this box, not speed.
6. Promote the copy to `python_embeded` only if step 5 is not a regression.

## Open questions I would not answer from here

- Does anything in your workflows still need flash_attn? Answer = "only Mochi/PixArt", so if you never
  run those, delete it and stop maintaining a hand-downloaded wheel.
- Which attention does ComfyUI actually pick per model now (comfy_kitchen `sol_attn` vs `na3d` vs
  SDPA vs SageAttention)? One launch with `--verbose` and it prints the choice per run; worth knowing
  before believing any benchmark, because with sageattention installed it may not be kitchen at all.
- Whether the 55 W power cap is why generation feels slow. If Anima/SDXL time is dominated by a power
  limit, no toolkit version will help and a BIOS/dGPU-only or plugged-in test is the real lever.

## The exact target, and every wheel is prebuilt (no MSVC compile, no `pip install flash-attn` suffering)

Verified against the GitHub release asset lists tonight, not from memory:

| what | exact artifact | where |
|---|---|---|
| torch | `torch==2.14.1+cu132` (2.0 GB wheel, CUDA libs bundled) | `https://download.pytorch.org/whl/cu132` |
| torchvision | `torchvision==0.29.2+cu132` (2.14 ↔ 0.29 pairing) | same index |
| **flash_attn** | `flash_attn-2.8.3+cu132torch2.14-cp311-cp311-win_amd64.whl`, **230 MiB** | `mjun0812/flash-attention-prebuild-wheels` tag `v0.10.2` |
| flash_attn_3 | `flash_attn_3-3.0.0+cu132torch2.14gite2743ab-cp39-abi3-win_amd64.whl` | same tag |
| sageattention (optional) | `sageattention-2.2.0+cu130torch2.10.0andhigher.post6-cp310-abi3-win_amd64.whl` | `woct0rdho/SageAttention` `v2.2.0-windows.post6` |

```
# the direct link, so nobody has to click through a release page
https://github.com/mjun0812/flash-attention-prebuild-wheels/releases/download/v0.10.2/flash_attn-2.8.3%2Bcu132torch2.14-cp311-cp311-win_amd64.whl
```

Notes that only the asset lists revealed:

- The **wheel matrix pins the torch version**: prebuilt Windows flash_attn for cu132 exists for
  torch **2.14** (tag v0.10.2) and torch **2.15** (tags v1.6.0/v1.6.1). Nothing for 2.13/cu132 at
  cp311, and the older v0.9.28 set is cp312/cp314 only. So "new torch + new flash_attn" is
  self-consistent at **2.14.1+cu132**, which is also the smaller jump from 2.9.1. (The repo tags move
  fast — v1.7.0 dated yesterday dropped Windows assets entirely, so re-check the list before
  downloading, and expect to have to name a tag rather than "latest".)
- **flash_attn_3 exists as a wheel.** FA3 is the hopper-and-later path and it is `abi3`, i.e. one wheel
  for cp39+. On an Ada card it will not be the fast path, but it means the FA2/FA3 install decision is
  not forced.
- SageAttention's CUDA-13 Windows wheel is **cu130**, built `torch2.10.0andhigher`, `cp310-abi3`
  (loads on 3.11). Mixing a cu130-built extension against a cu132 torch is legal inside CUDA 13
  (same `cudart64_13.dll` SONAME) but it is the one component here that is not version-matched, so if
  ComfyUI starts producing garbage images, that is the first thing to remove.
