#!/usr/bin/env node
// Dungeon Blaster alpha - game server. One origin for the browser client, the tracker, the GM turn,
// the voice server and the image server.
//
// Thin on purpose. This file owns no rules and no world: every mutation still goes through
// resolveRound() in tracker/engine.js, the turn still runs through game/gm.mjs (the same code the pi
// extension runs), and the only thing added here is HTTP and adapters. If you are looking for the place
// where a claim is won or a tier is chosen, it is not here - it is in rules/rules.md and the gate.
//
//   node game/server.mjs               real DM on :8080
//   node game/server.mjs --fake-dm     scripted DM, no model, no GPU: plays the whole loop anyway
//
// Env: DB_GAME_PORT (8765) · DB_TTS_URL (narrator) · DB_ASR_URL (audio.cpp :8081) · DB_ART_URL
// (ComfyUI :8188) · DB_PERSIST (append-only ledger like the extension) · DB_RULES · DB_DM_URL

import { createServer } from 'node:http';
import { existsSync, statSync } from 'node:fs';
// node:fs/promises, not node:fs: fs.readFile without a callback resolves to undefined, so every static
// file "does not exist" and every 404 looks like a wrong path instead of a wrong import.
import { readFile } from 'node:fs/promises';
import {extname, join, normalize, resolve, sep } from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import { loadRules } from '../tracker/rules_doc.js';
import { newGame, joinSlot, addMaterials, setIntents, saveGame } from '../tracker/engine.js';
import { runTurn, loadSchema, barkFor, RULES_PATH, ROOT, SLOT_NAMES, STARTING_KIT } from './gm.mjs';
import { loadArt } from './art.mjs';
import { ART_STYLES, DEFAULT_STYLE, resolveStyle } from './art/styles.mjs';
import { readFile as readText, writeFile as writeText } from 'node:fs/promises';

const PORT = Number(process.env.DB_GAME_PORT || 8765);
const HOST = '127.0.0.1';
const FAKE = process.argv.includes('--fake-dm');
const TTS_URL = process.env.DB_TTS_URL || '';
const ASR_URL = process.env.DB_ASR_URL || 'http://127.0.0.1:8081';
const ART_URL = process.env.DB_ART_URL || 'http://127.0.0.1:8188';
const ART_TEMPLATE = process.env.DB_ART_TEMPLATE || join(ROOT, 'game/art/anima_card_api.json');
const ART_DIR = join(ROOT, 'game/art');
const ART_STYLE = process.env.DB_ART_STYLE || DEFAULT_STYLE;
// Pre-generated art is the normal path; ComfyUI is a build-time tool. Live rendering stays available for
// the improvised stuff, but only when someone asks for it by name, because a render in the middle of a
// spoken line steals the card from TTS.
const art = loadArt(ART_DIR, ART_STYLE, { log: (m) => console.log(`[art] ${m}`) });
const ART_LIVE = process.env.DB_ART_LIVE === '1';
// Art style is a live setting, not a restart. Note what it does and does not do: it changes which style
// directory the resolver PREFERS. Assets already on screen keep the style they were drawn with, because
// every asset carries its own style - that is a property of pre-generation, not a bug to paper over.
const SETTINGS_PATH = join(ART_DIR, 'settings.json');
let artStyle = ART_STYLE;
try { artStyle = resolveStyle(JSON.parse(await readText(SETTINGS_PATH, 'utf8')).style).key; } catch { /* first run, no settings yet */ }
async function saveSettings() { try { await writeText(SETTINGS_PATH, JSON.stringify({ style: artStyle }, null, 1)); } catch (e) { console.log(`[settings] could not persist: ${e.message}`); } }
function settingsPayload() {
  const have = art.byStyle();
  return {
    style: artStyle,
    available: have,
    styles: ART_STYLES.map((x) => ({ key: x.key, label: x.label, rank: x.rank, engine: x.engine || 'anima', note: x.note, rendered: have[x.key] || 0 })),
  };
}
const CLIENT = join(ROOT, 'game/client');
const D20 = join(ROOT, 'spikes/d20');
const HOSTS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const rules = loadRules(process.env.DB_RULES || RULES_PATH);
const schema = loadSchema();

function freshTable() {
  const g = newGame(rules, { campaign: process.env.DB_CAMPAIGN || `alpha-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}` });
  // Seated automatically: this is a couch demo, and /dm_join's four-name ritual is not a feature an
  // alpha should make a stranger perform before they can see anything happen.
  SLOT_NAMES.forEach((name, i) => {
    const ch = joinSlot(g, i + 1, { name, class_label: 'wretch' });
    addMaterials(g, i + 1, { ...STARTING_KIT }, 'starting kit');
    return ch;
  });
  return g;
}

let g = freshTable();

// ------------------------------------------------------------------ adapters

/** Narrator. Fire and forget: audio is never allowed to hold a round hostage. */
function speak(text, voice = 'dm') {
  if (!TTS_URL || !text) return;
  fetch(TTS_URL, { method: 'POST', headers: { content: 'application/json' }, body: JSON.stringify({ text, voice }) })
    .catch(() => emit('log', { level: 'warn', msg: `TTS unreachable at ${TTS_URL} - playing silent` }));
}

/** ComfyUI. Returns a viewable URL, or null with a reason the UI can show instead of a blank card. */
async function renderArt(job) {
  // Manifest first, in --fake-dm too: a manifest hit is the difference between a demo with pictures in it
  // and a demo of grey boxes, and it costs a file check.
  const pre = art.resolve(job, { style: artStyle });
  // style_matches is reported upward rather than hidden: asking for shinkai and being served finnstark is
  // correct behaviour (nothing else is rendered) and a lie by omission the player cannot debug.
  if (pre) return { job, url: pre.url, pregen: true, asset: pre.id, style: pre.style, style_matches: pre.style_matches };
  const rec = await art.miss(job);
  if (!ART_LIVE) return { job, url: null, why: `${rec.why}; queued in game/art/queue.jsonl (set DB_ART_LIVE=1 to render now)` };
  if (!existsSync(ART_TEMPLATE)) return { job, url: null, why: 'no ComfyUI workflow template (game/art/anima_card_api.json)' };
  if (FAKE) return { job, url: null, why: 'art skipped in --fake-dm (no model, no reason to burn the GPU)' };
  try {
    const wf = JSON.parse(await readFile(ART_TEMPLATE, 'utf8'));
    const [w, h] = job.size || [640, 640];
    const seed = randomInt(1, 2 ** 31);
    // Prefix varies with the seed on purpose: ComfyUI's prompt cache only misses when both change, and a
    // cached hit would hand back the previous card for a different item.
    const prefix = `db-${job.kind}-${job.subject_id}`;
    const set = (id, patch) => { if (wf[id]) Object.assign(wf[id].inputs, patch); };
    set('67', { text: job.prompt_hint });
    set('68', { width: w, height: h, batch_size: 1 });
    set('70', { seed, steps: job.steps || 6 });
    set('9', { filename_prefix: `${prefix}-${seed}` });
    const r = await fetch(`${ART_URL}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'dungeon-blaster' }) });
    if (!r.ok) return { job, url: null, why: `ComfyUI ${r.status}: ${(await r.text()).slice(0, 120)}` };
    const { prompt_id } = await r.json();
    for (let i = 0; i < 120; i++) {
      await new Promise((s) => setTimeout(s, 500));
      const hist = await (await fetch(`${ART_URL}/history/${prompt_id}`)).json();
      const out = hist?.[prompt_id]?.outputs;
      const img = out && Object.values(out).flatMap((o) => o.images || [])[0];
      if (img) return { job, url: `${ART_URL}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${img.type}` };
    }
    return { job, url: null, why: 'ComfyUI produced nothing in 60s' };
  } catch (e) {
    return { job, url: null, why: `ComfyUI unreachable (${e.message})` };
  }
}

// --------------------------------------------------------------------- fake DM

/**
 * A scripted game master for machines with no model loaded. It still goes through the gate, so an alpha
 * on a quiet laptop proves the same law the real one obeys - and it deliberately fails on purpose,
 * because a build that only ever shows accepted rounds has never shown you the gate.
 */
let fakeTurn = 0;
function fakeComplete(game) {
  return async (messages) => {
    const intent = game.intents[0] || { id: 'i1', slot: 1, text: '' };
    const other = [1, 2, 3, 4].find((s) => s !== intent.slot && game.characters[s]) || 2;
    fakeTurn += 1;
    const mode = fakeTurn % 3 === 0 ? 'evil' : 'good';
    if (mode === 'good') {
      // Quoted, never conjugated: a fake DM that splices a player's whole sentence into its own grammar
      // produces "You knot your feel along the wall for a loose stone into something". Embarrassing, and
      // the real model will do something similar often enough that the UI should not be judged on it.
      const hint = intent.text ? ` over "${intent.text.slice(0, 42)}${intent.text.length > 42 ? '…' : ''}"` : '';
      return {
        narration: `You set to work${hint}, and the damp air gives up a shape you can hold. The torchlight agrees with you, for now.`,
        mutations: [{
          id: 'm1', tool: 'craft_item', actor: intent.slot, intent: intent.id,
          args: { name: 'Knotwood club', item_type: 'weapon', materials: [{ name: 'wood', qty: 2 }, { name: 'sinew', qty: 1 }] },
        }],
      };
    }
    // Evil: speaks for a slot that never issued an intent, and pays with a material the rules never heard
    // of. The strict pass must refuse all of it; the fallback pass keeps nothing it cannot verify.
    return {
      narration: `Bram forges a blade of pure moonglass and hands it to everyone at once.`,
      mutations: [{
        id: 'm1', tool: 'craft_item', actor: other, intent: intent.id,
        args: { name: 'Moonglass reaver', item_type: 'weapon', materials: [{ name: 'moonglass', qty: 9 }] },
      }],
    };
  };
}

// ----------------------------------------------------------------------- round

const clients = new Set();
function emit(type, data) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch { /* gone */ } }
}

function publicState() {
  const here = g.locations[g.party_location];
  return {
    campaign: g.campaign,
    round: g.round,
    order_seed: g.order_seed,
    place: here,
    mode: FAKE ? 'fake-dm' : 'live-dm',
    slots: [1, 2, 3, 4].map((s) => {
      const c = g.characters[s];
      if (!c) return { slot: s, seated: false };
      return {
        slot: s, seated: true, name: c.name, level: c.level, class: c.class_label,
        carrying: Object.keys(c.inventory).map((id) => g.items[id].name),
        materials: Object.fromEntries(Object.entries(c.materials).filter(([, q]) => q > 0)),
        intent: (g.intents.find((i) => i.slot === s) || {}).text || null,
      };
    }),
    items: Object.values(g.items).map((it) => ({ id: it.id, name: it.name, type: it.type?.name, tier: it.derived?.tier_name || null })),
  };
}

async function playRound(count = 1) {
  for (let r = 0; r < Math.min(4, Math.max(1, count)); r++) {
    const intents = g.intents.filter(Boolean).map((i) => ({ ...i }));
    setIntents(g, intents, { order_seed: randomUUID().replace(/-/g, '').slice(0, 16) });
    const t0 = performance.now();
    let out;
    try {
      out = await runTurn(g, { ctx: {}, schema, complete: FAKE ? fakeComplete(g) : undefined, notify: (m) => emit('log', { msg: m }) });
    } catch (e) {
      emit('error', { msg: `DM turn failed: ${e.message}`, hint: FAKE ? '' : 'is the DM server up? launch-alpha.ps1 starts it' });
      continue;
    }
    const ms = Math.round(performance.now() - t0);
    const { call, result, attempts } = out;
    if (!result) { emit('error', { msg: 'DM produced no usable contract; round dropped' }); continue; }

    const log = result.turn_log || {};
    const narration = log.narration || null;
    const bark = barkFor(log);
    const spoken = narration || bark;

    // Narration first, then the pictures: the sentence is what the players are waiting on, and a render
    // in front of it is a hole in the audio.
    if (spoken) speak(spoken);
    const art = [];
    for (const job of result.art_jobs || []) {
      emit('log', { msg: `art queued: ${job.kind} ${job.subject_id} (${job.size.join('x')}, ${job.steps} steps)` });
      const res = await renderArt(job);
      art.push(res);
      emit('art', res);
    }

    emit('round', {
      round: g.round, spoken, narration, bark,
      blocked: log.narration_blocked || null,
      mode: log.mode || 'strict',
      committed: (result.committed || []).map((c) => c.tool),
      rejected: (result.rejected || []).map((x) => ({ id: x.id, code: x.code, reason: x.reason, allowed: x.allowed })),
      diffs: result.diffs || [],
      attempts: attempts.length, ms,
      tokens_out: attempts[attempts.length - 1]?.log?.tokens_out ?? null,
      art,
    });
    // Cleared before the state frame goes out, or the client repaints a round that has already been spent
    // and shows an intent the table is no longer holding.
    g.intents = [];
    emit('state', publicState());
    if (process.env.DB_PERSIST) { try { saveGame(g); } catch (e) { emit('log', { level: 'warn', msg: `persist failed: ${e.message}` }); } }
  }
}

// ------------------------------------------------------------------------ http

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function file(res, path) {
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'content-type': HOSTS[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch (e) {
    // Loud on purpose. A missing file and a broken code path must not wear the same 404.
    console.error(`[file] ${path}: ${e.code || ''} ${e.message}`);
    json(res, 404, { error: 'not found', file: path });
  }
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const path = u.pathname;
  try {
    if (path === '/api/state') return json(res, 200, publicState());

    if (path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ mode: FAKE ? 'fake-dm' : 'live-dm', round: g.round })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'POST' && path === '/api/intent') {
      const { slot, text } = JSON.parse((await body(req)).toString('utf8') || '{}');
      const s = Number(slot);
      if (!g.characters[s]) return json(res, 400, { error: `slot ${slot} is not seated` });
      const clean = String(text || '').trim().slice(0, 400);
      if (!clean) return json(res, 400, { error: 'nothing said' });
      // In-round intent, straight onto the mutable tail. setIntents() belongs to the round boundary
      // because it advances the round counter and re-seeds contention.
      g.intents = [...g.intents.filter((i) => i.slot !== s), { id: `r${g.round + 1}s${s}`, slot: s, text: clean, ready: true }];
      emit('state', publicState());
      return json(res, 200, { ok: true, slot: s, text: clean });
    }

    if (req.method === 'POST' && path === '/api/round') {
      const { n } = JSON.parse((await body(req)).toString('utf8') || '{}');
      // Answered immediately: a real DM turn is tens of seconds, and the client learns the outcome on SSE.
      json(res, 202, { ok: true, pending: true, mode: FAKE ? 'fake-dm' : 'live-dm' });
      playRound(Number(n) || 1);
      return;
    }

    if (req.method === 'POST' && path === '/api/roll') {
      // The value is minted here, in the deterministic layer, and the animation is told what happened.
      // The die is theatre: it visualises this number and can never disagree with it (spikes/d20/README.md).
      const value = randomInt(1, 21);
      emit('roll', { value });
      return json(res, 200, { value });
    }

    if (req.method === 'POST' && path === '/api/say') {
      const wav = await body(req);
      if (!wav.length) return json(res, 400, { error: 'no audio' });
      const fd = new FormData();
      fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'talk.wav');
      fd.append('model', 'parakeet-tdt-0.6b-v3');
      const r = await fetch(`${ASR_URL}/v1/audio/transcriptions`, { method: 'POST', body: fd, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) return json(res, 502, { error: `ASR ${r.status}`, hint: 'is audio.cpp up on :8081? launch-alpha.ps1 starts it' });
      const j = await r.json();
      const text = String(j.text || j.transcript || '').trim();
      return json(res, 200, { text });
    }

    if (req.method === 'POST' && path === '/api/new') {
      g = freshTable();
      emit('state', publicState());
      emit('log', { msg: 'new table, four seats filled' });
      return json(res, 200, publicState());
    }

    if (path.startsWith('/d20/')) return file(res, join(D20, normalize(path.slice(5))));
    if (path === '/api/settings' && req.method === 'GET') return json(res, 200, settingsPayload());
    if (path === '/api/settings' && req.method === 'POST') {
      // body() hands back a Buffer (line 290 parses the same way); treating it as an object is how the
      // first version of this handler answered a perfectly good POST with a 400.
      let b; try { b = JSON.parse((await body(req)).toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'body must be JSON' }); }
      // A missing or non-string style is a broken request, not a request to go back to the default. The
      // first version of this fell through resolveStyle's graceful fallback and happily persisted one, so a
      // malformed POST (a truncated body, a bad quote in a shell) silently restyled the game and wrote it to
      // disk. Falling back is for a save that names a style this build dropped, and that stays visible.
      if (!b || typeof b.style !== 'string' || !b.style.trim()) return json(res, 400, { error: 'style (string) required' });
      const known = ART_STYLES.some((x) => x.key === b.style);
      const key = resolveStyle(b.style).key;
      if (!known) console.log(`[settings] "${b.style}" is not a style in this build - falling back to ${key}`);
      const changed = key !== artStyle;
      artStyle = key;
      if (changed) await saveSettings();
      return json(res, 200, { ok: true, changed, requested: b.style, fell_back: !known, ...settingsPayload() });
    }
    if (path.startsWith('/art/')) {
      const f = resolve(join(ART_DIR, normalize(path.slice(5))));
      if (f !== resolve(ART_DIR) && !f.startsWith(resolve(ART_DIR) + sep)) return json(res, 403, { error: 'art path must stay inside game/art' });
      return file(res, f);
    }
    if (path === '/' || path === '/index.html') return file(res, join(CLIENT, 'index.html'));
    const guess = join(CLIENT, normalize(path));
    if (guess.startsWith(CLIENT) && existsSync(guess) && statSync(guess).isFile()) return file(res, guess);
    return json(res, 404, { error: 'not found', path });
  } catch (e) {
    console.error(`[http] ${path}: ${e.message}`);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Dungeon Blaster alpha  http://${HOST}:${PORT}  (${FAKE ? 'fake DM, no model needed' : `DM ${process.env.DB_DM_URL || 'http://127.0.0.1:8080'}`})`);
  console.log(`  voice   ${TTS_URL ? `${TTS_URL} (narrator), ${ASR_URL} (ASR)` : 'off - set DB_TTS_URL for the narrator'}`);
  console.log(`  art     ${ART_URL}${FAKE ? ' (art renders off in --fake-dm)' : ''}`);
  console.log(`  table   ${g.campaign}, ${Object.keys(g.characters).length} seated, round ${g.round}`);
});
