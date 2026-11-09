#!/usr/bin/env node
// Qwen Image 2.1 T2I, rebuilt from Blarmo's ComfyUI workflow (qwen_image_21-basic_t2i-1.json) as an API
// graph. Two things were dropped on purpose:
//
//   * the prompt enhancer (TextGenerate + a qwen3vl prompt-rewrite pass). His own ComfySwitchNode has it
//     off, and it costs a second 8B model call per card on a card that is also doing the DM's work.
//   * the subgraph + ResolutionSelector. The subgraph only computes width/height from an aspect-ratio
//     preset, and an API caller can supply width/height directly.
//
// Everything else is his graph, node for node: int8 convrot turbo UNet, qwen3vl text encoder, the 2.1 VAE,
// 8 steps at cfg 1 with euler_ancestral/beta. Verified against the real server, not against the JSON.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMFY = process.env.DB_COMFY_URL || 'http://127.0.0.1:8188';
export const QWEN = {
  unet: 'qwen_image_2.1_turbo_int8_convrot.safetensors',
  clip: 'qwen3vl_8b_w4a8.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
  // His negative prompt, verbatim. It is tuned for this model, so I am not improvising a better one.
  negative: 'basic, simple, 3D, duplicated legs, too many eyes, multiple heads.',
  steps: 8,
  cfg: 1,
};

function graph({ width, height, prompt, negative, steps, seed, prefix, layered }) {
  const g = {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: QWEN.unet, weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: QWEN.clip, type: 'qwen_image', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: QWEN.vae } },
    // resolution is the reference-image resize target; we send no reference images, so it only needs to be
    // a sane number and 1024 is what the workflow uses.
    pos: { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['clip', 0], prompt, negative_prompt: negative, resolution: 1024 } },
    neg: { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['clip', 0], prompt: negative, negative_prompt: negative, resolution: 1024 } },
    ks: {
      class_type: 'KSampler',
      inputs: {
        model: ['unet', 0], positive: ['pos', 0], negative: ['neg', 0], latent_image: ['latent', 0],
        seed, steps, cfg: QWEN.cfg, sampler_name: 'euler_ancestral', scheduler: 'beta', denoise: 1,
      },
    },
    dec: { class_type: 'VAEDecode', inputs: { samples: ['ks', 0], vae: ['vae', 0] } },
    out: { class_type: 'SaveImage', inputs: { images: ['dec', 0], filename_prefix: prefix } },
  };
  // The layered latent is how this model carries alpha. Plain EmptyLatentImage gives RGB and the
  // "transparent background" in the prompt is then just a painted background, which is a lie the UI
  // would happily composite over a page-coloured panel.
  g.latent = layered
    ? { class_type: 'EmptyQwenImageLayeredLatentImage', inputs: { width, height, layers: 3, batch_size: 1 } }
    : { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
  return g;
}

async function j(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${url} ${(await r.text()).slice(0, 400)}`);
  return r;
}

/** Render one card. Returns { file, outPath, bytes, ms, id }. */
export async function renderQwen({ prompt, negative = QWEN.negative, width = 704, height = 704, steps = QWEN.steps, seed, prefix = 'db-qwen', layered = false, outPath, log = () => {} }) {
  const t0 = Date.now();
  const wf = graph({ width, height, prompt, negative, steps, seed: seed ?? Math.floor(Math.random() * 1e15), prefix, layered });
  const p = await (await j(`${COMFY}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'db-pregen' }) })).json();
  if (p.error) throw new Error(`prompt rejected: ${JSON.stringify(p.error).slice(0, 500)}`);
  for (let i = 0; i < 1200; i++) {
    const h = await (await j(`${COMFY}/history/${p.prompt_id}`)).json();
    const rec = h[p.prompt_id];
    if (rec?.outputs) {
      const saved = Object.values(rec.outputs).flatMap((o) => o.images || []);
      if (!saved.length) throw new Error('no image in outputs: ' + JSON.stringify(rec.outputs).slice(0, 300));
      const s = saved[0];
      const buf = Buffer.from(await (await j(`${COMFY}/view?filename=${encodeURIComponent(s.filename)}&subfolder=${encodeURIComponent(s.subfolder || '')}&type=${s.type}`)).arrayBuffer());
      const id = { file: s.filename, subfolder: s.subfolder, type: s.type };
      if (outPath) { await mkdir(dirname(outPath), { recursive: true }); await writeFile(outPath, buf); }
      return { ...id, bytes: buf.length, ms: Date.now() - t0, outPath };
    }
    if (rec?.status?.status_str === 'error') throw new Error(rec.status?.messages?.map((m) => JSON.stringify(m)).join(' ').slice(0, 400) || 'execution error');
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${p.prompt_id}`);
}

// Probe CLI: one card, and a plain-language answer about whether it actually has an alpha channel.
if (process.argv[1] && process.argv[1].endsWith('qwen.mjs')) {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
  const prompt = a.filter((x, i) => !x.startsWith('--') && a[i - 1] !== `--${get('x', 'x')}` && !['--w', '--h', '--steps', '--out', '--prefix', '--layered', '--seed'].includes(a[i - 1]))[0];
  if (!prompt) { console.log('usage: node game/art/qwen.mjs "<prompt>" [--w 704 --h 704 --steps 8 --layered --out C:/x.png]'); process.exit(2); }
  const out = get('out', null);
  const r = await renderQwen({ prompt, width: +get('w', 704), height: +get('h', 704), steps: +get('steps', QWEN.steps), layered: a.includes('--layered'), outPath: out, log: console.error });
  console.log(`${r.file}  ${r.bytes} bytes  ${(r.ms / 1000).toFixed(1)}s  layered=${a.includes('--layered')}${out ? ' -> ' + out : ''}`);
  if (out) {
    // Read the PNG header rather than trust the prompt: colour type 6 means RGBA, 2 means RGB.
    const b = await readFile(out);
    const colorType = b.readUInt8(25);
    console.log(`png colour type ${colorType} = ${colorType === 6 ? 'RGBA (real alpha)' : colorType === 2 ? 'RGB (no alpha - transparency is painted on)' : 'other'}`);
  }
}
