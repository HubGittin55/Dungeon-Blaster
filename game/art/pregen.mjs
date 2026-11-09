// Pre-generation batch for everything the game shows that is NOT improvised at the table.
//
// The split is deliberate. Characters, items and locations are things the DM invents mid-session, so
// their art has to be generatable at runtime (or absent). Raw materials are a closed vocabulary - the
// rules say the DM cannot invent a material, MATERIAL_UNKNOWN is the error for trying - so all 32 of
// them are known at build time and every one of them should be a fixed, hand-pickable image. Same
// reasoning for the static furniture: a menu backdrop is never rolled.
//
// The material list is READ FROM rules/rules.md at run time. A duplicate list here would be a second
// source of truth, and the day someone adds a material the art set would quietly stop covering it.
//
//   node game/art/pregen.mjs                 everything (~40 cards, ~12 min on the 4060)
//   node game/art/pregen.mjs --only mat_     just materials
//   node game/art/pregen.mjs --only ui_panel just one asset
//   node game/art/pregen.mjs --engine anima  the old Anima 2.9B path (kept so a style can be rebuilt)
//
// Seeds are derived from the asset id, so re-running reproduces the same picture and an asset keeps
// its identity across rebuilds. The manifest records the sha256 of the bytes it was written for.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveStyle } from './styles.mjs';
import { renderQwen, QWEN } from './qwen.mjs';
import { pngInfo } from './png.mjs';

const ART_URL = process.env.DB_ART_URL || 'http://127.0.0.1:8188';
const TEMPLATE = new URL('./anima_card_api.json', import.meta.url);
const RULES = new URL('../../rules/rules.md', import.meta.url);
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
// Two engines now: qwen-image (Blarmo's Qwen Image 2.1 graph - 1MP, real alpha, legible text) and anima
// (the 640px SD-graph path that made the first set). Default is qwen because it is strictly better at
// everything the game shows except speed, and 18s per card is a build-time cost, not a table-time one.
const ENGINE = flag('engine', process.env.DB_ART_ENGINE || 'qwen');
const STYLE_KEY = process.env.DB_ART_STYLE || (ENGINE === 'qwen' ? 'finnstark' : 'shinkai');
const style = resolveStyle(STYLE_KEY);
const ROOT = new URL('./', import.meta.url);
const OUT = new URL(`${style.key}/`, ROOT);
const MANIFEST = new URL('manifest.json', ROOT);

const ITEM_SUFFIX = ', single object centred on plain dark ground, soft warm rim light, shallow depth of field, no hands, no people, no words, no lettering, item card';
// Descriptions, not names: "iron" as a prompt gets you an ingot-shaped nothing. Each one says what the
// thing looks like lying on a table, because these cards sit next to each other in a crafting screen
// and a player has to tell tin from silver at a glance across a couch.
const MATERIAL_ART = {
  wood: 'a rough-hewn oak plank with axe marks and pale sap', clay: 'a damp lump of grey river clay, thumbprints in it',
  cloth: 'a folded square of undyed coarse linen, frayed edge', bone: 'a cleaned animal femur, sun-bleached and chipped',
  flint: 'a knapped black flint nodule, conchoidal fractures glinting', sinew: 'a coil of dried animal tendon, pale and waxy',
  reed: 'a bundle of dried marsh reeds tied with twine', tin: 'two dull grey ingots with a soft matte sheen',
  ochre: 'a clay pot of red ochre powder with a stained wooden spatula',
  iron: 'a dark forged iron bar with hammer scale and rust bloom', steel: 'a polished steel bar, bright ground edge',
  hardwood: 'a dense dark heartwood block with tight grain', leather: 'a supple tan hide, edges burnished',
  copper: 'a red-gold copper ingot with a green fingertip of verdigris', silver: 'a bright silver ingot, stamped hallmarks',
  wool: 'a thick folded wool blanket with a cable weave', shell: 'an abalone shell, nacre interior catching light',
  'mithral-ingot': 'a pale silver-white ingot, faintly luminous, hovering a hair above the ground',
  gleamhide: 'a hide of overlapping bog-green scales, wet and glossy', 'lumen-gem': 'a faceted clear gem with cold light moving inside it',
  'silverleaf-steel': 'a folded blade blank, silver veins in dark steel', 'deep-amber': 'a lump of amber with an insect sealed inside',
  'basilisk-scale': 'a single heavy grey-green scale, keeled ridge, stone-grey at the edges',
  'chimera-sinew': 'a braided cord of three differently-coloured sinews', voidglass: 'a shard of black glass that drinks the light, no reflection',
  'ironbark-heart': 'a cross-section of iron-dark wood with a rust-coloured heart', 'phoenix-cinder': 'an ember that has not gone out, ash flaking off it',
  dreamthread: 'a thread that is slightly out of focus, trailing off the spool', 'firstfire-ember': 'a coal with the first flame still clinging to it',
  'kings-oath-stone': 'a worn river stone with a carved crown worn smooth', 'worldroot-splinter': 'a pale splinter of living root, damp and fibrous',
  'starfall-core': 'a meteoric core, pitted and still warm at the cracks',
};
const ui = (w, h, prompt, opt = {}) => ({ w, h, prompt, ...opt });
const UI_ASSETS = {
  // Backdrops are the only opaque kind: a backdrop with an alpha channel is a backdrop with holes in it.
  ui_menu_backdrop: ui(1344, 768, 'vast empty dungeon hall at first light, one high window throwing a shaft, dust motes, long shadows, full-bleed painted background, edge to edge, no vignette, no people, no words, no lettering', { opaque: true }),
  ui_settings_backdrop: ui(1344, 768, 'workbench covered in rolled maps, compass and chalk rubbings, warm lamp glow, cool window behind, full-bleed painted background, edge to edge, no people, no words, no lettering', { opaque: true }),
  // The one place baked lettering is right: a title. It never changes, never gets localised, and this
  // model draws text accurately, so it is free production value. Every label that CAN change stays in the
  // DOM, because a PNG cannot say "3 of 4 players joined".
  ui_title_logo: ui(1024, 512, 'game title logo reading DUNGEON BLASTER in carved angular fantasy lettering, brass rivets, a d20 replacing the A, bold black outline, one flat cast shadow, exactly that text and no other text, no subtitle'),
  ui_panel_plate: ui(1024, 1024, 'ornate fantasy panel: worn leather frame with brass corners around an empty pale vellum centre, bold black outline, flat even light, empty centre with no text, no words, no lettering, no symbols'),
  ui_button_plate: ui(768, 256, 'horizontal polished bronze button plaque with beveled bold-outlined edges, empty face with no text, no words, no lettering, no symbols'),
  ui_divider_ornament: ui(1024, 192, 'thin horizontal band of carved grey stone with brass rivets and a subtle wave motif, bold black outline, flat even light, no words, no lettering'),
  ui_slot_placeholder: ui(640, 896, 'empty alcove with a folded travel cloak, bare helm and empty belt hung on wooden hooks, waiting for nobody, bold black outline, no people, no words, no lettering'),
  ui_dice_tray: ui(1024, 1024, 'empty worn wooden dice tray lined with faded green felt, a little sawdust and grit in the corner, top-down three-quarter view, bold black outline, no dice, no words, no lettering'),
};

const seedFor = (id) => parseInt(createHash('sha256').update(`${style.key}:${id}`).digest('hex').slice(0, 8), 16) % 2147483647;
const rulesText = await readFile(RULES, 'utf8');
const matBlock = rulesText.slice(rulesText.indexOf('"materials": ['));
const names = [...matBlock.matchAll(/\{\s*"name": "([a-z\-]+)"\s*,\s*"tier":\s*(\d)/g)].map((m) => ({ name: m[1], tier: +m[2] }));
if (names.length < 30) { console.error(`rules.md gave ${names.length} materials; refusing to write a short manifest`); process.exit(1); }

const only = flag('only', null);
if (ENGINE === 'anima' && !existsSync(TEMPLATE)) { console.error(`missing workflow template ${TEMPLATE}`); process.exit(1); }

// Qwen gets an icon suffix that asks for a cut-out; Anima's suffix asked for a plain dark ground, which
// would fight the alpha channel, so the two engines cannot share one suffix.
const QWEN_ICON = ', single object filling the frame, bold black outline, one flat cast shadow to the lower right, floating on nothing, no ground, no table, no hands, no people, no words, no lettering, game crafting icon';
const assets = [];
for (const m of names) {
  const id = `mat_${m.name}`;
  const desc = MATERIAL_ART[m.name];
  if (!desc) { console.error(`no art description for material "${m.name}" - the rules know a material this batch cannot draw`); process.exit(1); }
  const size = ENGINE === 'qwen' ? { w: 704, h: 704 } : { w: 640, h: 640 };
  assets.push({ id, kind: 'material', tier: m.tier, ...size, prompt: `${desc}${ENGINE === 'qwen' ? QWEN_ICON : ITEM_SUFFIX}` });
}
for (const [id, spec] of Object.entries(UI_ASSETS)) {
  assets.push({ id, kind: id.startsWith('ui_menu') || id.startsWith('ui_settings') ? 'backdrop' : 'ui', ...spec, opaque: spec.opaque || false });
}
const picked = only ? assets.filter((a) => a.id.includes(only)) : assets;
if (!picked.length) { console.error(`--only ${only} matched nothing`); process.exit(2); }
await mkdir(OUT, { recursive: true });

// The style string comes from the registry (styles.mjs), never from a copy here, for the same reason the
// material list comes from rules.md: a second place that names the style is a second thing to forget when
// the style changes. Blarmo's starting prompt, verbatim as the front of every qwen positive.
const qwenPrompt = (a) => `${style.tag}. ${a.opaque ? 'Full-bleed opaque painted background.' : 'The image has a transparent background.'} The subject is ${a.prompt}.`;

const set = (wf, id, patch) => { if (wf[id]) Object.assign(wf[id].inputs, patch); };
console.log(`${picked.length} assets, engine ${ENGINE}, style "${style.key}" (${style.tag}), seeds derived from ids`);
let n = 0;
const done = [];
const failed = [];
for (const a of picked) {
  const seed = seedFor(a.id);
  const file = `${style.key}/${a.id}.png`;
  // fileURLToPath, not .pathname: a file: URL gives back "/C:/Users/..." and Windows writes that somewhere
  // nobody looks for, so the render appears to succeed and the file is simply not in the repo.
  const outPath = fileURLToPath(new URL(file, ROOT));
  const prompt = ENGINE === 'qwen' ? qwenPrompt(a) : `${a.prompt}, ${style.tag}`;
  const t0 = Date.now();
  try {
    if (ENGINE === 'qwen') {
      await renderQwen({ prompt, width: a.w, height: a.h, seed, prefix: `${style.key}-${a.id}`, outPath });
    } else {
      const wf = JSON.parse(await readFile(TEMPLATE, 'utf8'));
      set(wf, '67', { text: prompt });
      set(wf, '68', { width: a.w, height: a.h, batch_size: 1 });
      set(wf, '70', { seed, steps: 6 });
      set(wf, '9', { filename_prefix: `${style.key}-${a.id}-${seed}` });
      const r = await fetch(`${ART_URL}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'db-pregen' }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
      const { prompt_id } = await r.json();
      let img = null;
      for (let i = 0; i < 300 && !img; i++) {
        await new Promise((s) => setTimeout(s, 500));
        const h = await (await fetch(`${ART_URL}/history/${prompt_id}`)).json();
        img = h?.[prompt_id]?.outputs && Object.values(h[prompt_id].outputs).flatMap((o) => o.images || [])[0];
      }
      if (!img) throw new Error('no output after 150s');
      const buf = Buffer.from(await (await fetch(`${ART_URL}/view?type=output&filename=${encodeURIComponent(img.filename)}`)).arrayBuffer());
      await writeFile(outPath, buf);
    }
  } catch (e) { failed.push({ id: a.id, why: String(e.message || e).slice(0, 200) }); console.log(`  !! ${a.id}: ${String(e.message || e).slice(0, 120)}`); continue; }

  const buf = await readFile(outPath);
  // Read the pixels, not the prompt. A material card whose alpha is uniformly 255 is an opaque square that
  // will punch a rectangle out of whatever panel it lands on, and the batch would otherwise ship it happily.
  const info = await pngInfo(outPath).catch(() => null);
  const alpha = info?.alpha ? { min: info.alpha.min, mean: info.alpha.mean, transparent: info.alpha.transparent, corner: info.alpha.corner } : null;
  const cutOut = !!alpha && alpha.transparent > 0.02 && alpha.corner < 90;
  const warn = alpha === null ? 'no alpha channel' : (!a.opaque && !cutOut ? 'asked for transparency, delivered opaque' : '');
  done.push({ id: a.id, kind: a.kind, tier: a.tier || null, engine: ENGINE, file, w: info?.width || a.w, h: info?.height || a.h, seed, sha256: createHash('sha256').update(buf).digest('hex'), alpha, cut_out: a.opaque ? null : cutOut, prompt });
  console.log(`  ${(++n).toString().padStart(2)}/${picked.length} ${a.id.padEnd(22)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${(buf.length / 1024) | 0} KB  ${alpha ? `a${alpha.transparent ? Math.round(alpha.transparent * 100) + '%tr' : 'opaque'}` : 'no-a'}${warn ? '  <= ' + warn : ''}`);
}

// Manifest only ever describes what actually got written, so a partial run cannot claim a full set.
const prior = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, 'utf8')) : { assets: [] };
const byId = new Map(prior.assets.map((a) => [a.id, a]));
for (const a of done) byId.set(a.id, a);
const manifest = {
  schema: 'db-art-1', style: style.key, styleTag: style.tag, engine: ENGINE, generated: new Date().toISOString(),
  workflow: ENGINE === 'qwen' ? 'qwen_image_21-basic_t2i-1 (rebuilt as API graph, prompt enhancer off)' : 'anima_card_api.json',
  steps: ENGINE === 'qwen' ? QWEN.steps : 6,
  assets: [...byId.values()].sort((x, y) => x.id.localeCompare(y.id)),
  missing: failed.map((f) => f.id),
};
await writeFile(MANIFEST, JSON.stringify(manifest, null, 1) + '\n');
console.log(`\nmanifest: ${manifest.assets.length} assets -> game/art/manifest.json`);
const noAlpha = done.filter((d) => d.cut_out === false);
if (noAlpha.length) console.log(`NOTE: ${noAlpha.length} asset(s) were asked for transparency and came back opaque: ${noAlpha.map((d) => d.id).join(' ')}`);
if (failed.length) { console.log(`FAILED ${failed.length}:`); for (const f of failed) console.log(`  ${f.id}: ${f.why}`); }
process.exit(failed.length ? 1 : 0);
