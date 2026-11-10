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
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {extname, join, normalize, resolve, sep } from 'node:path';
import { randomUUID, randomInt } from 'node:crypto';
import { loadRules } from '../tracker/rules_doc.js';
import { newGame, joinSlot, addMaterials, setIntents, saveGame, takeSeat, characterLaw } from '../tracker/engine.js';
import { runTurn, loadSchema, barkFor, RULES_PATH, ROOT, SLOT_NAMES, STARTING_KIT } from './gm.mjs';
import { loadArt, assetId } from './art.mjs';
import { ART_STYLES, DEFAULT_STYLE, resolveStyle, styleTag } from './art/styles.mjs';
import { readFile as readText, writeFile as writeText } from 'node:fs/promises';

const PORT = Number(process.env.DB_GAME_PORT || 8765);
const HOST = '127.0.0.1';
const FAKE = process.argv.includes('--fake-dm');

// The last thing the table was told. This used to exist only as a pushed event, so refreshing a screen rewrote
// the story back to the opening line, and a round's narration - once heard - was gone from the world. The
// telling is state now: it belongs to a round, and it survives a reload, a fifth phone, and a rejoin.
const OPENING_TELLING = 'Four of you wake up in a damp cell with a door and a rumour of stairs. Say what you do, then press Play round.';
let telling = { round: 0, text: OPENING_TELLING, bark: false };
const TTS_URL = process.env.DB_TTS_URL || '';
const ASR_URL = process.env.DB_ASR_URL || 'http://127.0.0.1:8081';
const TTS_VOICE = process.env.DB_TTS_VOICE || 'af';

/**
 * What is this box called?
 *
 * Both voice failures this build had the same shape: a model name copied from another vendor's docs. The
 * mic path asked audio.cpp for 'parakeet-tdt-0.6b-v3' and got HTTP 500 'unknown model id'; the narrator
 * asked for no model at all and got 'missing required json key: model'. The boxes know their own names -
 * :8081 answers 'asr', :8082 answers 'tts' - so they are asked once and the answer is cached. Nothing here
 * is a hardcoded model name any more, which is the only way it stays true when the model is swapped out.
 */
const modelCache = new Map();
async function modelId(origin, kind) {
  const key = `${origin}|${kind}`;
  if (modelCache.has(key)) return modelCache.get(key);
  try {
    const r = await fetch(`${origin}/v1/models`, { signal: AbortSignal.timeout(5_000) });
    const ids = ((await r.json()).data || []).map((m) => m.id);
    const id = ids.find((x) => x === kind) || ids.find((x) => x.startsWith(kind)) || ids[0] || null;
    if (id) modelCache.set(key, id);
    return id;
  } catch { return null; }
}

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
  // Seats are deliberately EMPTY until each player declares a sheet under rule.characters. The alpha used to
  // seat four named wretches so a stranger could see something move immediately; once there was a character
  // law, an auto-seated fake person was worse than an empty chair - it nodded along, held kit, and could not
  // be argued with. Four empty seats and a Create screen is the game asking who is playing.
  return g;
}

let g = freshTable();
// One game master turn is one moment of the fiction, and a real turn takes tens of seconds. Nothing in
// the server ever said so. Two POSTs to /api/round both got 202 and both resolved against the same
// table: the wood was spent twice and one club appeared, and a /api/new that landed mid-turn left the
// fresh table wearing the previous campaign's telling. The round is the critical section; the door now
// says so instead of letting four tabs and a laggy laptop discover it. Measured, not theorised:
// test/redteam/probe-http2.mjs with a 2s stub, and the "one round at a time" section of test/http_test.
let roundInFlight = null; // { id, started } while a turn is resolving, else null

/**
 * A legal sheet, dealt.
 *
 * "Surprise me" is a real way to start a four-player game on a couch, and the roll is only legal because it
 * is built inside the same limits a human is held to: min on every attribute, nothing above the cap, exactly
 * the pool spent. Random here means unposed, not unchecked - takeSeat still refuses it if it were not.
 */
function randomSheet(slot) {
  const law = characterLaw(g);
  const names = law.attributes.map((a) => a.name);
  const attributes = Object.fromEntries(names.map((k) => [k, law.min_start]));
  let left = law.points - names.length * law.min_start;
  for (let guard = 0; left > 0 && guard < 500; guard++) {
    const k = names[randomInt(names.length)];
    if (attributes[k] < law.max_start) { attributes[k] += 1; left -= 1; }
  }
  return {
    name: SLOT_NAMES[slot - 1] || `Player ${slot}`,
    cls: law.classes[randomInt(law.classes.length)].name,
    attributes,
  };
}

// Table-time pictures come from the fast engine, and the fast engine has its own look: a scene painted in
// three seconds during play belongs to the style whose tag the Anima workflow was tuned for, not to the
// build-time style. The resolver happily serves across styles and reports which one it used.
const TABLE_STYLE = (ART_STYLES.find((s) => (s.engine || 'anima') === 'anima') || {}).key || ART_STYLE;

/**
 * Draw something now, keep it forever.
 *
 * The live path used to return a ComfyUI URL and forget it: the same corridor would be rolled again next
 * session as a different corridor, and a reload lost the picture. Saving the file and recording it in the
 * manifest is what turns "generated" into "that place looks like that from now on".
 */
/**
 * Draw something now, at table speed, and keep it.
 *
 * Everything the table invents goes through the fast engine (Anima, a couple of seconds), because the point
 * of the game is saying a thing and seeing it. The build-time engine stays a build-time tool: it made the
 * forty shipped cards, and it never appears in a turn. Style is chosen by the setting, not by which box the
 * idea came from - the look of a game is an @artist tag, not a pipeline.
 *
 * The seed comes from the words. "a flooded crypt, ankle-deep black water" paints the same crypt next
 * Saturday as it did tonight, which is the difference between a generated picture and *the* picture.
 */
function seedFor(style, id, prompt) {
  return parseInt(createHash('sha256').update(`${style}:${id}:${prompt}`).digest('hex').slice(0, 8), 16) % 2147483647;
}

async function generateArt(job) {
  if (!job.prompt_hint) return { ok: false, why: 'nothing to draw - describe it first' };
  if (!existsSync(ART_TEMPLATE)) return { ok: false, why: `no ComfyUI workflow template at ${ART_TEMPLATE}` };
  const style = job.style || TABLE_STYLE;
  const [w, h] = job.size || [832, 832];
  const id = assetId(job);
  const prompt = `${job.prompt_hint}, ${styleTag(style)}`;
  const seed = job.seed || seedFor(style, id, prompt);
  const file = `${style}/${id}.png`;
  // Belt and braces with safeId, and the same test the GET side runs: the answer is a path under game/art or
  // it is not an answer. Checked on the joined path, because that is the thing being written, not its parts.
  const target = resolve(ART_DIR, style, `${id}.png`);
  if (!target.startsWith(resolve(ART_DIR) + sep)) return { ok: false, why: `art id '${job.subject_id}' would write outside game/art` };
  try {
    const wf = JSON.parse(await readFile(ART_TEMPLATE, 'utf8'));
    const set = (nid, patch) => { if (wf[nid]) Object.assign(wf[nid].inputs, patch); };
    set('67', { text: prompt });
    set('68', { width: w, height: h, batch_size: 1 });
    set('70', { seed, steps: job.steps || 6 });
    set('9', { filename_prefix: `db-${job.kind}-${id}-${seed}` });
    const r = await fetch(`${ART_URL}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'dungeon-blaster' }) });
    if (!r.ok) return { ok: false, why: `ComfyUI ${r.status}: ${(await r.text()).slice(0, 160)}` };
    const { prompt_id } = await r.json();
    for (let i = 0; i < 240; i++) {
      await new Promise((s) => setTimeout(s, 500));
      const hist = await (await fetch(`${ART_URL}/history/${prompt_id}`)).json();
      const img = hist?.[prompt_id]?.outputs && Object.values(hist[prompt_id].outputs).flatMap((o) => o.images || [])[0];
      if (!img) continue;
      const view = `${ART_URL}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${img.type}`;
      const buf = Buffer.from(await (await fetch(view)).arrayBuffer());
      await mkdir(join(ART_DIR, style), { recursive: true });
      await writeFile(target, buf);
      // Recorded against the style that drew it, so a live render of a pre-drawn subject becomes the picture
      // for *that* style and leaves the other styles' files alone. The resolver picks per setting.
      const rec = await art.record({ id, style, kind: job.kind, subject_id: job.subject_id, file, w, h, seed, engine: 'anima', sha256: createHash('sha256').update(buf).digest('hex'), prompt, at: new Date().toISOString() });
      emit('art', { job, url: rec?.url || `/art/${file}`, pregen: false, asset: id, style });
      return { ok: true, url: rec?.url || `/art/${file}`, file, id, seed, bytes: buf.length };
    }
    return { ok: false, why: 'ComfyUI produced nothing in 2 minutes' };
  } catch (e) {
    return { ok: false, why: `ComfyUI unreachable (${e.message}) - is :8188 up?` };
  }
}

/**
 * Paint whatever the tracker just minted, without stopping the game for it.
 *
 * Material cards are a fixed vocabulary: wood is wood in every campaign, so those forty were drawn once, at
 * build time, by the build engine, and they are already on disk. Everything on this list exists only because
 * the table invented it five seconds ago - this club, this potion, the NPC who just gave a name - so it is
 * painted now by the fast engine, off the critical path. The round is already committed and the narration is
 * already on its way to the speakers; four people must not watch a spinner because a club needs a face.
 * Until it lands, the seat card shows the card of whatever the thing is made of: an honest placeholder that
 * at least tells the truth about its own materials.
 */
const painting = new Set();
function paintQueued(job) {
  // The engine files rooms by location id; the client looks rooms up as scene_<id>. One convention, owned
  // here, or a painted corridor and a looked-up corridor never meet.
  const subject = job.kind === 'environment'
    ? sceneJob(g.locations[job.subject_id] || { id: job.subject_id }).subject_id
    : job.subject_id;
  const key = `${job.kind}:${subject}`;
  if (painting.has(key)) return;
  // Already drawn? Then the table is looking at it, and nothing needs rendering. Checked here rather than
  // inside generateArt, because the scene path deliberately re-paints: new words describe a new room.
  const done = art.resolve({ kind: job.kind, subject_id: subject }, { style: artStyle });
  if (done) { emit('art', { job, url: done.url, pregen: true, asset: done.id, style: done.style }); return; }
  painting.add(key);
  emit('log', { msg: `painting: ${job.kind} ${subject}` });
  generateArt({ ...job, subject_id: subject })
    .then((res) => {
      if (res.ok) {
        emit('art', { job, url: res.url, pregen: false, asset: res.id, style: String(res.file).split('/')[0] });
        emit('state', publicState());
        emit('log', { msg: `painted ${subject} (${Math.round((res.bytes || 0) / 1024)} KB, seed ${res.seed})` });
      } else {
        emit('log', { msg: `could not paint ${subject}: ${res.why}` });
      }
    })
    .catch((e) => emit('log', { msg: `painting ${subject} fell over: ${e.message}` }))
    .finally(() => painting.delete(key));
}

// ------------------------------------------------------------------ adapters

/**
 * Narrator. Renders the clip and pushes it to every couch screen as a `speech` event.
 *
 * It used to POST the text and throw the response away, so the narrator had never once been audible and the
 * code looked like it worked. Still fire-and-forget in the round path: a 20-second voice render must never
 * hold up a table, so narration audio arrives a beat late rather than blocking a beat.
 */
async function speakNow(text) {
  if (!TTS_URL || !text) return null;
  const origin = new URL(TTS_URL).origin;
  const model = await modelId(origin, 'tts');
  const r = await fetch(TTS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: text, voice: TTS_VOICE, response_format: 'wav' }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) {
    const why = (await r.text().catch(() => '')).slice(0, 160);
    emit('log', { msg: `narrator silent: TTS ${r.status} ${why}` });
    return null;
  }
  const buf = Buffer.from(await r.arrayBuffer());
  emit('speech', { clip: `data:audio/wav;base64,${buf.toString('base64')}`, bytes: buf.length, text });
  return buf;
}

function speak(text, voice = 'dm') {
  speakNow(text).catch((e) => emit('log', { msg: `narrator silent: ${e.message} - is the voice box up on :8082?` }));
}

// A voice line the player can click, because "the narrator is wired up" is not a thing anyone can believe
// from a log line. Used by the Voice button, and by nothing else.
const VOICE_TEST_LINE = 'Four of you wake up in a damp cell, with a door, and a rumour of stairs.';

// --------------------------------------------------------------------- fake DM

/**
 * A scripted game master for machines with no model loaded. It still goes through the gate, so an alpha
 * on a quiet laptop proves the same law the real one obeys - and it deliberately fails on purpose,
 * because a build that only ever shows accepted rounds has never shown you the gate.
 */
let fakeTurn = 0;
// --evil (or DB_FAKE_EVIL=3) turns the illegal rounds back on: one turn in three invents a player who never
// spoke and a material the rules never heard of. Off by default, because a demo that randomly talks nonsense
// reads as broken to a person, and the gate already gets that abuse from the evil-bot suite.
const EVIL_EVERY = process.argv.includes('--evil') ? 3 : Number(process.env.DB_FAKE_EVIL || 0);
const CRAFTISH = /\b(craft|forge|make|build|tie|lash|whittle|carve|knap|repair|mend|fashion|sharpen)\b/i;

/**
 * The scripted DM for --fake-dm.
 *
 * It used to read game.intents[0] and nothing else, and answer whatever you typed with "you craft a Knotwood
 * club". That made a fine gate test rig and a bewildering game: three of four players were dropped every
 * round and the narration described something nobody asked for. So it now walks every intent and says one
 * true plain thing about each, and only proposes a mutation when the words look like a craft. A round where
 * nothing is crafted then commits with no mutations and changes nothing - which is itself worth watching,
 * because "the telling said something and the tracker allowed it" is the whole design.
 *
 * Still quoted rather than conjugated: splicing a player's sentence into the fake DM's own grammar produces
 * "You knot your feel along the wall for a loose stone into something", and the real model does something
 * similar often enough that the UI should not be judged on it.
 */
function fakeComplete(game) {
  return async () => {
    fakeTurn += 1;
    if (EVIL_EVERY > 0 && fakeTurn % EVIL_EVERY === 0) {
      const intent = game.intents[0] || { id: 'i1', slot: 1, text: '' };
      const other = [1, 2, 3, 4].find((s) => s !== intent.slot && game.characters[s]) || 2;
      return {
        narration: 'Bram forges a blade of pure moonglass and hands it to everyone at once.',
        mutations: [{
          id: 'm1', tool: 'craft_item', actor: other, intent: intent.id,
          args: { name: 'Moonglass reaver', item_type: 'weapon', materials: [{ name: 'moonglass', qty: 9 }] },
        }],
      };
    }
    const lines = [];
    const mutations = [];
    for (const it of game.intents.filter(Boolean)) {
      // SLOT_NAMES is 0-based (index 0 is slot 1), so indexing it by a slot number hands every player their
      // neighbour's name and calls the last seat "Slot 4". Prefer the character on the seat: names are the
      // thing a table can change, and the narration should follow it.
      const who = game.characters?.[it.slot]?.name || SLOT_NAMES[it.slot - 1] || `Slot ${it.slot}`;
      const text = String(it.text || '').trim().replace(/\s+/g, ' ');
      const said = text ? `"${text.length > 64 ? text.slice(0, 64) + '\u2026' : text}"` : 'stands still and listens';
      if (CRAFTISH.test(text) && !mutations.length) {
        mutations.push({
          id: 'm1', tool: 'craft_item', actor: it.slot, intent: it.id,
          args: { name: 'Knotwood club', item_type: 'weapon', materials: [{ name: 'wood', qty: 2 }, { name: 'sinew', qty: 1 }] },
        });
        lines.push(`${who} works on ${said} and ends up holding a lashed length of knotwood.`);
      } else {
        lines.push(`${who} tries ${said}. The room does not change.`);
      }
    }
    if (!lines.length) lines.push('Nobody says anything. The cell stays exactly as damp as it was.');
    return { narration: lines.join(' '), mutations };
  };
}

// ----------------------------------------------------------------------- round

const clients = new Set();
function emit(type, data) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch { /* gone */ } }
}

// Asset ids for the world's own subjects live here, in one place. A scene saved under a name the client
// never asks for is a picture that exists and is never shown, which is indistinguishable from no art.
const sceneJob = (loc) => ({ kind: 'environment', subject_id: `scene_${loc.id}` });
const faceJob = (label) => ({ kind: 'portrait', subject_id: `face_${String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_')}` });
const cardUrl = (material) => { const a = art.resolve({ kind: 'material', subject_id: material }, { style: artStyle }); return a ? a.url : null; };

function publicState() {
  const here = g.locations[g.party_location];
  // Only the cards that are actually on the table. The client cannot look an asset id up by itself - the
  // whole point of the resolver is that style and fallback are decided in one place - so the URLs travel
  // with the state, and a material nobody holds costs nothing.
  const inPlay = [...new Set([1, 2, 3, 4].flatMap((s) => Object.keys((g.characters[s] || {}).materials || {})))];
  return {
    campaign: g.campaign,
    round: g.round,
    order_seed: g.order_seed,
    // The room the party is in, with its art resolved. Front and centre because it is the first thing a
    // player should see and the last thing they should have to ask for.
    place: { ...here, art: art.resolve(sceneJob(here), { style: artStyle }) },
    law: characterLaw(g),
    seats_open: [1, 2, 3, 4].filter((s) => !g.characters[s]),
    // Everyone the DM has introduced, with the face the table painted for them. introduce_npc used to be a
    // mutation whose only visible consequence was a line of prose: the engine knew the ferrywoman existed, and
    // the gate had already checked she wasn't a duplicate, but the couch could not see her - and her portrait
    // was being rendered into a manifest nobody asked about.
    npcs: Object.values(g.npcs).map((n) => {
      const face = art.resolve({ kind: 'character', subject_id: n.id }, { style: artStyle });
      return { id: n.id, name: n.name, role: n.role || null, art: face ? face.url : null };
    }),
    cards: Object.fromEntries(inPlay.map((m) => [m, cardUrl(m)])),
    // Faces for the classes on offer, so the creation screen can show who you would be playing rather than
    // making the choice from three words of flavour text.
    class_faces: Object.fromEntries(characterLaw(g).classes.map((c) => [c.name, (art.resolve(faceJob(c.name), { style: artStyle }) || {}).url || null])),
    mode: FAKE ? 'fake-dm' : 'live-dm',
    telling,
    slots: [1, 2, 3, 4].map((s) => {
      const c = g.characters[s];
      if (!c) return { slot: s, seated: false };
      return {
        slot: s, seated: true, name: c.name, level: c.level, class: c.class_label, xp: c.xp,
        attributes: c.attributes, sheet: c.sheet || null,
        // An item's face is the card of whatever it is mostly made of - the 32 material drawings do the
        // work of 10,000 item drawings, and they are already on disk. `type` is a bare string in the
        // tracker; an earlier draft of this line read `.type.name` and every glyph silently vanished.
        carrying: Object.keys(c.inventory).map((id) => {
          const it = g.items[id];
          const type = typeof it.type === 'string' ? it.type : (it.type || {}).name || null;
          const made_of = (it.materials_spent || [])[0]?.name || null;
          // The thing's own face once the table has painted it; until then, the card of whatever it is mostly
          // made of. Both are real pictures of real facts - only the second one is a placeholder.
          const face = art.resolve({ kind: 'item', subject_id: it.id }, { style: artStyle })
            || (made_of ? art.resolve({ kind: 'material', subject_id: made_of }, { style: artStyle }) : null);
          const own = !!face && face.id === String(it.id);
          return { id, name: it.name, type, tier: it.tier || 1, made_of, art: face ? face.url : null, own };
        }),
        // A face the table described wins over the class stock portrait; with nothing described, the class
        // face is what you get, and both go through the same resolver.
        portrait: art.resolve(c.face && c.face.id ? { kind: 'portrait', subject_id: c.face.id } : faceJob(c.class_label), { style: artStyle }),
        materials: Object.fromEntries(Object.entries(c.materials).filter(([, q]) => q > 0)),
        intent: (g.intents.find((i) => i.slot === s) || {}).text || null,
      };
    }),
    items: Object.values(g.items).map((it) => ({ id: it.id, name: it.name, type: it.type?.name, tier: it.derived?.tier_name || null })),
  };
}

async function playRound(count = 1) {
  if (roundInFlight) return false; // the route answers 409; this is the belt for every other caller
  const ticket = (roundInFlight = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, started: Date.now() });
  const mine = g; // the table this turn belongs to, so a reset mid-turn can be recognised and dropped
  try {
  for (let r = 0; r < Math.min(4, Math.max(1, count)); r++) {
    // The objects this round carries, kept by identity: a word that arrives while the game master is
    // deciding must survive into the next round, and clearing by slot or by id would eat it as well.
    const consumed = g.intents.filter(Boolean);
    const intents = consumed.map((i) => ({ ...i }));
    setIntents(g, intents, { order_seed: randomUUID().replace(/-/g, '').slice(0, 16) });
    const t0 = performance.now();
    let out;
    try {
      out = await runTurn(g, { ctx: {}, schema, complete: FAKE ? fakeComplete(g) : undefined, notify: (m) => emit('log', { msg: m }) });
    } catch (e) {
      emit('error', { msg: `DM turn failed: ${e.message}`, hint: FAKE ? '' : 'is the DM server up? launch-alpha.ps1 starts it' });
      continue;
    }
    if (mine !== g) {
      // Someone started a new table while this turn was in the model. The old table is gone, so the turn
      // is dropped rather than spoken over a campaign it knows nothing about - and "dropped" is logged,
      // because a round that vanishes without a word is the thing a table cannot debug afterwards.
      emit('log', { level: 'warn', msg: 'the table was reset while this round was resolving; the turn is dropped, not spoken over the new campaign' });
      return true;
    }
    const ms = Math.round(performance.now() - t0);
    const { call, result, attempts } = out;
    if (!result) { emit('error', { msg: 'DM produced no usable contract; round dropped' }); continue; }

    const log = result.turn_log || {};
    const narration = log.narration || null;
    const bark = barkFor(log);
    const spoken = narration || bark;
    telling = { round: g.round, text: spoken, bark: !narration };

    // Narration first, then the pictures: the sentence is what the players are waiting on, and a render
    // in front of it is a hole in the audio. So the renders are not awaited - the round payload reports what
    // was asked for, and each picture arrives on its own `art` event when it lands.
    if (spoken) speak(spoken);
    const art = (result.art_jobs || []).map((job) => ({ job, url: null, queued: true, why: 'painting' }));
    for (const job of result.art_jobs || []) paintQueued(job);

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
    // Only the intents this round carried are cleared. Words that arrived while the game master was
    // deciding belong to the next round: they used to be wiped with everything else, so a player who
    // typed during a 40-second turn got HTTP 200 and then nothing at all - their line unspoken, their
    // seat quiet, and no rejection to point at. The rules are explicit that a failed intent is never a
    // stolen turn; silently discarding one is the same theft with better manners.
    g.intents = g.intents.filter((i) => !consumed.includes(i));
    emit('state', publicState());
    if (process.env.DB_PERSIST) { try { saveGame(g); } catch (e) { emit('log', { level: 'warn', msg: `persist failed: ${e.message}` }); } }
  }
  } finally {
    if (roundInFlight === ticket) roundInFlight = null;
  }
  return true;
}

// ------------------------------------------------------------------------ http

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

/**
 * Request bodies, one door.
 *
 * Every route used to open its own `JSON.parse((await body(req))...)`, and only one of the seven bothered to
 * catch. A truncated POST - a phone locking mid-request, a bad quote in a shell - therefore threw out of the
 * handler and answered 500 with a JavaScript parse error, which is the shape of bug this build is supposed to
 * be on the side of: the client did something illegal and the server blamed itself. It is also the difference
 * between "malformed input is refused with the legal shape attached" and a law that only holds when the input
 * happens to be well-formed. `body must be JSON` now answers every bad body on every route, in the same words.
 *
 * The cap is not paranoia about attacks; it is that `for await (const c of req)` with no limit will happily
 * assemble a 2 GB body in RAM on a laptop that is also holding a 35B model, a TTS model and ComfyUI.
 */
const MAX_BODY = 64 * 1024;
async function body(req, max = MAX_BODY) {
  const chunks = [];
  let size = 0;
  let over = false;
  // A request that dies halfway is not a server error. Without this listener an aborted POST - the phone that
  // locked mid-tap, the browser tab closed while a room was being described - surfaces as an 'error' event on
  // the request stream with nobody watching, which is an uncaught exception, which is the game ending for four
  // players because somebody closed a laptop. http_test.mjs watched the process exit 143 over exactly this.
  req.on('error', () => { req.aborted = true; });
  for await (const c of req) {
    size += c.length;
    if (size > max) {
      // Drain and discard rather than dropping the socket. The first version answered 413 and destroyed the
      // connection, and the next POST on that same keep-alive connection hung for five minutes waiting for a
      // response to a request nobody had finished reading - so "refused" and "broken" looked identical from the
      // client. Someone posting 4 MB to a character-sheet endpoint made a mistake; someone posting a gigabyte
      // is flooding, and only that gets closed, after 32 MB of refusing to buffer any more of it.
      if (size > max * 512) { const e = new Error(`body over ${max * 512} bytes`); e.status = 507; req.destroy(); throw e; }
      over = true;
      continue;
    }
    chunks.push(c);
  }
  if (over) { const e = new Error(`body over ${max} bytes`); e.status = 413; throw e; }
  if (req.aborted) { const e = new Error('client hung up mid-body'); e.status = 499; throw e; }
  return Buffer.concat(chunks);
}

/**
 * Parse a body or answer for the caller. Returns null once a reply has been sent, so a handler reads:
 *   const p = await readJSON(req, res); if (!p) return;
 * A parse failure says what JSON is; an array or a bare scalar says what this server accepts, because "body
 * must be JSON" is no help to someone who sent `[{"slot":1}]` and believes they did exactly that.
 */
async function readJSON(req, res) {
  let raw;
  try { raw = (await body(req)).toString('utf8').trim(); }
  catch (e) {
    if (e.status === 499) return null;                       // nobody left to tell
    if (e.status === 413) json(res, 413, { error: `${e.message} - this is a character sheet, not a save file` });
    else json(res, 500, { error: e.message });
    return null;
  }
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { json(res, 400, { error: `body must be JSON (${e.message}) - an object like {"slot":1}` }); return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    json(res, 400, { error: 'body must be a JSON object like {"slot":1}, not an array or a bare value' });
    return null;
  }
  return parsed;
}

/**
 * Which chair, or nothing.
 *
 * The routes used to write `Number(p.slot)`, which is fine until someone sends `[2]`: Number() of a one-element
 * array is 2, so an array was a legal way to sit in seat two while `"abc"` was correctly refused. Coercion that
 * accepts JSON types nobody means is a hole with the shape of convenience - so a slot is a whole number from 1
 * to 4, or a string that is exactly one, and everything else is answered with the range.
 */
function slotOf(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^[1-4]$/.test(value.trim())) return Number(value.trim());
  return null;
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
      const q = await readJSON(req, res);
      if (!q) return;
      const { text } = q;
      const s = slotOf(q.slot);
      if (s === null) return json(res, 400, { error: 'slot must be 1-4' });
      if (!g.characters[s]) return json(res, 400, { error: `slot ${q.slot} is not seated` });
      const clean = String(text || '').trim().slice(0, 400);
      if (!clean) return json(res, 400, { error: 'nothing said' });
      // In-round intent, straight onto the mutable tail. setIntents() belongs to the round boundary
      // because it advances the round counter and re-seeds contention.
      g.intents = [...g.intents.filter((i) => i.slot !== s), { id: `r${g.round + 1}s${s}`, slot: s, text: clean, ready: true }];
      // Say which round the words belong to. During a turn they cannot make that turn - the prompt is
      // already written - and the honest answer is "next", not a 200 that quietly means "lost".
      emit('state', publicState());
      return json(res, 200, {
        ok: true, slot: s, text: clean,
        queued_for_round: g.round + 1,
        in_flight: !!roundInFlight,
        why: roundInFlight ? 'the round being decided was written before this was said; it lands in the next one' : null,
      });
      return json(res, 200, { ok: true, slot: s, text: clean });
    }

    if (req.method === 'POST' && path === '/api/round') {
      const q = await readJSON(req, res);
      if (!q) return;
      if (roundInFlight) {
        // 409, not a queued 202: a second round behind the first would resolve against the state the
        // first is about to change, which is how a round gets paid for and nothing arrives.
        return json(res, 409, {
          error: 'a round is already resolving',
          in_flight: roundInFlight.id,
          elapsed_ms: Date.now() - roundInFlight.started,
          reason: 'one game master turn at a time: two rounds resolving at once spend the same wood twice',
        });
      }
      // Answered immediately: a real DM turn is tens of seconds, and the client learns the outcome on SSE.
      json(res, 202, { ok: true, pending: true, mode: FAKE ? 'fake-dm' : 'live-dm' });
      playRound(Number(q.n) || 1);
      return;
    }

    if (req.method === 'POST' && path === '/api/roll') {
      // The value is minted here, in the deterministic layer, and the animation is told what happened.
      // The die is theatre: it visualises this number and can never disagree with it (spikes/d20/README.md).
      const value = randomInt(1, 21);
      emit('roll', { value });
      return json(res, 200, { value });
    }

    /**
     * Take a seat. Player-declared on purpose: there is no tool in the model's vocabulary that creates a
     * character or spends points, because a game master that can allocate stats has already decided how the
     * adventure goes. The rules do the arguing (see takeSeat) and the rejection comes back verbatim so the
     * screen can show which line of the sheet is wrong.
     */
    if (req.method === 'POST' && path === '/api/seat') {
      const p = await readJSON(req, res);
      if (!p) return;
      const slot = slotOf(p.slot);
      if (slot === null) return json(res, 400, { error: 'slot must be 1-4' });
      if (![1, 2, 3, 4].includes(slot)) return json(res, 400, { error: 'slot must be 1-4' });
      if (p.random) {
        const dealt = randomSheet(slot);
        if (!p.name) p.name = dealt.name;
        if (!p.cls) p.cls = dealt.cls;
        if (!p.attributes) p.attributes = dealt.attributes;
      }
      const wasEmpty = !g.characters[slot];
      const out = takeSeat(g, slot, { name: p.name, cls: p.cls, attributes: p.attributes });
      if (!out.ok) return json(res, 400, { error: 'the rules refused this sheet', rejected: out.rejected });
      // The kit follows an empty pair of hands, not "the first time this chair was used". Re-declaring a
      // sheet before round one replaces the character object, and a character who sat down with nothing
      // would never get the starting kit the rules imply. Nothing that already holds something is topped up,
      // so this is not a way to print materials.
      const ch = out.character;
      // The described face travels with the sheet: words in, that face out, for as long as they play them.
      if (p.face && typeof p.face.id === 'string') ch.face = { id: p.face.id.slice(0, 48), prompt: String(p.face.prompt || '').slice(0, 400) };
      if (!Object.keys(ch.materials).length && !Object.keys(ch.inventory).length) addMaterials(g, slot, { ...STARTING_KIT }, 'starting kit');
      emit('state', publicState());
      emit('log', { msg: `slot ${slot} sits down: ${ch.name}, ${ch.class_label}${wasEmpty ? '' : ' (re-declared before play)'}` });
      return json(res, 200, { ok: true, slot, seat: publicState().slots[slot - 1] });
    }

    /**
     * Describe the room you are in, then paint it.
     *
     * The alpha shipped one sentence of stock furniture for the opening location and no way to change it.
     * A campaign should start by saying what the place looks like and seeing that picture become the place -
     * description, render, record, and the corridor keeps that face for the rest of the session.
     */
    if (req.method === 'POST' && path === '/api/scene') {
      const p = await readJSON(req, res);
      if (!p) return;
      const here = g.locations[g.party_location];
      const desc = String(p.description || '').trim();
      if (desc) { here.description = desc.slice(0, 400); here.prompt_hint = String(p.prompt_hint || desc).slice(0, 400); }
      if (!p.generate) { emit('state', publicState()); return json(res, 200, { ok: true, place: here }); }
      // Table resolution: the hero panel is 16:9 and the browser scales it, so the table gets its room in a
      // couple of seconds instead of waiting on a print-resolution file. The build batch still ships 1344s.
      const job = { ...sceneJob(here), prompt_hint: here.prompt_hint || here.description, size: [1024, 576], steps: 4 };
      const done = await generateArt(job);
      if (done.ok) here.art_asset_id = done.id;
      emit('state', publicState());
      return json(res, done.ok ? 200 : 502, done.ok ? { ok: true, place: here, art: done } : { error: done.why, place: here });
    }

    /** Draw one named subject now and keep it: used for the scene, and for anything else the table invents. */
    if (req.method === 'POST' && path === '/api/art/generate') {
      const p = await readJSON(req, res);
      if (!p) return;
      const kind = String(p.kind || 'environment');
      const subject_id = String(p.subject_id || g.party_location);
      const done = await generateArt({ kind, subject_id, prompt_hint: String(p.prompt_hint || ''), size: p.size || [1024, 576], steps: p.steps || 6 });
      if (!done.ok) return json(res, 502, { error: done.why });
      emit('state', publicState());
      return json(res, 200, done);
    }

    /**
     * Speak a face into existence.
     *
     * Same rule as the room: the description is the identity, so the id is a hash of the words and "tall,
     * scarred, one grey eyebrow" paints the same person tonight and next Saturday. Rendered by the fast
     * engine because this happens while four people are waiting to start.
     */
    if (req.method === 'POST' && path === '/api/portrait') {
      const p = await readJSON(req, res);
      if (!p) return;
      const description = String(p.description || '').trim().slice(0, 400);
      if (description.length < 8) return json(res, 400, { error: 'describe them in a sentence first - "a guy" is not enough to paint' });
      const id = `face_${createHash('sha256').update(description.toLowerCase()).digest('hex').slice(0, 12)}`;
      const done = await generateArt({ kind: 'portrait', subject_id: id, prompt_hint: `portrait of ${description}`, size: [640, 800], steps: 4 });
      return json(res, done.ok ? 200 : 502, done.ok ? { ok: true, id, url: done.url, seed: done.seed } : { error: done.why });
    }

    if (req.method === 'POST' && path === '/api/voice_test') {
      const buf = await speakNow(VOICE_TEST_LINE);
      if (!buf) {
        return json(res, 502, { error: 'narrator did not answer', hint: TTS_URL ? `nothing came back from ${TTS_URL}` : 'voice is off - launch without -NoVoice' });
      }
      res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
      return res.end(buf);
    }
    if (req.method === 'POST' && path === '/api/say') {
      const wav = await body(req);
      if (!wav.length) return json(res, 400, { error: 'no audio' });
      const fd = new FormData();
      fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'talk.wav');
      const asrModel = await modelId(new URL(ASR_URL).origin, 'asr');
      if (asrModel) fd.append('model', asrModel);
      const r = await fetch(`${ASR_URL}/v1/audio/transcriptions`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) {
        // The box explains itself better than this hint ever could: 'unknown model id' and 'no such file'
        // are different problems wearing the same 502.
        const why = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 180);
        return json(res, 502, { error: `ASR ${r.status}`, hint: `${why || 'audio.cpp gave no reason'} (:8081)` });
      }
      const j = await r.json();
      const text = String(j.text || j.transcript || '').trim();
      return json(res, 200, { text });
    }

    if (req.method === 'POST' && path === '/api/new') {
      if (roundInFlight) {
        // Wiping the table mid-turn is how a fresh campaign inherited the old one's telling. The turn is
        // dropped if it lands after a reset, but the polite answer is to say "in a moment" instead.
        return json(res, 409, {
          error: 'a round is resolving; start over the moment it lands',
          in_flight: roundInFlight.id,
          elapsed_ms: Date.now() - roundInFlight.started,
        });
      }
      g = freshTable();
      telling = { round: 0, text: OPENING_TELLING, bark: false };
      emit('state', publicState());
      emit('log', { msg: 'new table, four empty seats waiting to be declared' });
      return json(res, 200, publicState());
    }

    if (path.startsWith('/d20/')) return file(res, join(D20, normalize(path.slice(5))));
    if (path === '/api/settings' && req.method === 'GET') return json(res, 200, settingsPayload());
    if (path === '/api/settings' && req.method === 'POST') {
      // body() hands back a Buffer (line 290 parses the same way); treating it as an object is how the
      // first version of this handler answered a perfectly good POST with a 400.
      const b = await readJSON(req, res);
      if (!b) return;
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
