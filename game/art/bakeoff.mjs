// Style bake-off: the same three subjects, five @artist tags, one variable at a time.
//
// This drives the *shipping* render path on purpose - same template file, same node ids, same 640x640,
// same 6 steps, same negative prompt as game/server.mjs renderArt(). A style that only looks good in a
// hand-tuned workflow is not a style, it is a different workflow.
//
//   node game/art/bakeoff.mjs                 all 15
//   node game/art/bakeoff.mjs goblin          one subject, 5 styles
//   node game/art/bakeoff.mjs goblin shinkai  one cell
//
// Outputs are copied to C:/dm/art/style/ so they survive ComfyUI's output folder churn. Nothing is
// written into the repo: these are candidate assets, not source.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const ART_URL = process.env.DB_ART_URL || 'http://127.0.0.1:8188';
const TEMPLATE = new URL('./anima_card_api.json', import.meta.url);
const OUT = process.env.DB_STYLE_DIR || 'C:/dm/art/style';

// The three things Slice 1 actually needs art for: a creature to fight, a place to stand, an object to
// craft. Every style is judged on the same trio, so a style that only flatters portraits gets caught.
const SUBJECTS = {
  goblin: 'a goblin raider, hooked notched sword, scrap leather armour, crouching to lunge, single creature, torchlit cavern behind, dark background, creature card',
  cavern: 'torchlit stone cavern, low timber support beams, wet flagstones, pale mushrooms, empty room, no people, no text, location card',
  club: 'a knotted wooden club with iron binding, single object, plain dark ground, dramatic light, no hands, no people, no text, item card',
};

// Exactly as Blarmo named them. Anima switches style on @artist tags, so these go in the positive prompt
// verbatim rather than being paraphrased into adjectives.
const STYLES = {
  bengal: 'Bengal comic illustration',
  shinkai: '@makoto_shinkai style',
  mita: '@mita_pikazo style',
  gerph: '@gerph style',
  mini: '@minillustration style',
};

// Filter: no args = everything. Otherwise each argument may name a subject, a style key, or part of an
// @artist tag ("gerph" works, "shinkai" works). If the args only match one dimension, the other stays full.
const args = process.argv.slice(2).map((a) => a.toLowerCase());
const matchSubject = (k) => !args.length || args.some((a) => k.startsWith(a) || SUBJECTS[k].toLowerCase().includes(a));
const matchStyle = (k) => !args.length || args.some((a) => k.startsWith(a) || STYLES[k].toLowerCase().includes(a));
const subjects = Object.keys(SUBJECTS).filter(matchSubject);
const useStyles = Object.keys(STYLES).filter(matchStyle);
const hitS = subjects.length > 0, hitT = useStyles.length > 0;
// An argument that only names a subject (or only names a style) must not silently collapse the other
// dimension to nothing - "bakeoff goblin" means that subject in every style.
if (args.length && !subjects.length) subjects.push(...Object.keys(SUBJECTS));
if (args.length && !useStyles.length) useStyles.push(...Object.keys(STYLES));
// ...but a typo that matches nothing at all should not quietly render the whole matrix on an 8 GB card.
if (args.length && !hitS && !hitT) {
  console.error(`nothing matches ${JSON.stringify(args)}\nsubjects: ${Object.keys(SUBJECTS).join(' ')}\nstyles:   ${Object.keys(STYLES).join(' ')}`);
  process.exit(2);
}
if (!subjects.length || !useStyles.length) {
  console.error(`subjects: ${Object.keys(SUBJECTS).join(' ')}\nstyles:   ${Object.keys(STYLES).join(' ')}`);
  process.exit(2);
}
if (!existsSync(TEMPLATE)) { console.error(`no template at ${TEMPLATE}`); process.exit(1); }
await mkdir(OUT, { recursive: true });

const set = (wf, id, patch) => { if (wf[id]) Object.assign(wf[id].inputs, patch); };
const log = (m) => process.stdout.write(m + '\n');

log(`bake-off: ${useStyles.length} styles x ${subjects.length} subjects = ${useStyles.length * subjects.length} cards, 640x640, 6 steps`);
const rows = [];
for (const st of useStyles) {
  for (const sb of subjects) {
    const wf = JSON.parse(await readFile(TEMPLATE, 'utf8'));
    const seed = 1000 + Object.keys(STYLES).indexOf(st) * 977 + Object.keys(SUBJECTS).indexOf(sb) * 53;
    const prefix = `bo-${st}-${sb}`;
    set(wf, '67', { text: `${SUBJECTS[sb]}, ${STYLES[st]}` });
    set(wf, '68', { width: 640, height: 640, batch_size: 1 });
    set(wf, '70', { seed, steps: 6 });
    set(wf, '9', { filename_prefix: `${prefix}-${seed}` });
    const t0 = Date.now();
    const r = await fetch(`${ART_URL}/prompt`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: wf, client_id: 'dungeon-blaster-bakeoff' }),
    });
    if (!r.ok) { rows.push({ st, sb, err: `HTTP ${r.status}: ${(await r.text()).slice(0, 140)}` }); log(`  ${st}/${sb}  REJECTED ${rows.at(-1).err}`); continue; }
    const { prompt_id } = await r.json();
    let img = null;
    for (let i = 0; i < 240 && !img; i++) {
      await new Promise((s) => setTimeout(s, 500));
      const hist = await (await fetch(`${ART_URL}/history/${prompt_id}`)).json();
      img = hist?.[prompt_id]?.outputs && Object.values(hist[prompt_id].outputs).flatMap((o) => o.images || [])[0];
    }
    if (!img) { rows.push({ st, sb, err: 'no output after 120s' }); log(`  ${st}/${sb}  TIMEOUT`); continue; }
    const buf = Buffer.from(await (await fetch(`${ART_URL}/view?type=output&filename=${encodeURIComponent(img.filename)}`)).arrayBuffer());
    const file = `${OUT}/${st}-${sb}.png`;
    await writeFile(file, buf);
    const secs = ((Date.now() - t0) / 1000).toFixed(2);
    rows.push({ st, sb, file, secs, bytes: buf.length, comfy: img.filename });
    log(`  ${st.padEnd(8)} ${sb.padEnd(7)} ${secs}s  ${(buf.length / 1024) | 0} KB  -> ${file}`);
  }
}
log('');
for (const r of rows) log(r.err ? `${r.st}/${r.sb}: ERROR ${r.err}` : `${r.st}/${r.sb}: ${r.secs}s ${r.file}`);
const bad = rows.filter((r) => r.err).length;
log(`\n${rows.length - bad} rendered, ${bad} failed`);
process.exit(bad ? 1 : 0);
