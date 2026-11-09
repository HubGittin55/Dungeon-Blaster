// Pre-generated art resolution. One job goes in, one viewable URL comes out or an explicit reason
// comes out - never a silent null, because a blank card and a broken card look identical on a couch.
//
// The manifest is the record of a batch that already ran (game/art/pregen.mjs writes it), so this file
// owns no truth about what art exists; it reads what is on disk, and reloads when the file changes so
// iterating on a bad card does not need a server restart.
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
// Aliased on purpose. The module declares a function called resolve() below, function declarations hoist,
// and an unaliased import meant resolve(artRoot) on the next lines was calling THE ART RESOLVER with a path
// string: it returned null, null !== null is false, the && short-circuited, and the traversal guard never
// fired once - while legitimate paths still worked by accident. Import resolve, shadow resolve, ship a
// guard made of confetti.
import { resolve as pathResolve } from 'node:path';

const slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/**
 * Ids the game asks for -> ids the batch produced, in strict order, first hit wins.
 * Deliberately conservative: a fuzzy match would hang a goblin portrait on a tin ingot and the
 * player would have no way to know the game was lying to them.
 */
function candidateIds(job) {
  const out = [];
  // Raw id FIRST, then the slug. My first version only tried the slug, and slug() maps '-' to '_'. Every
  // material the rules spell with a hyphen - mithral-ingot, deep-amber, starfall-core, kings-oath-stone,
  // 14 of the 32 - then resolves to nothing, and a manifest that says the art exists serves a blank card.
  // The rules' own vocabulary is the one that has to survive the mapping.
  const raw = String(job.subject_id || '').trim();
  if (raw) {
    out.push(raw, `mat_${raw}`);
    const s = slug(raw);
    out.push(s); if (!s.startsWith('mat_')) out.push(`mat_${s}`);
  }
  const nraw = String(job.name || (job.item && job.item.name) || '').trim();
  if (nraw) {
    const n = slug(nraw);
    out.push(nraw, n, `mat_${nraw}`, `mat_${n}`, `item_${n}`, `ui_${n}`, `loc_${n}`);
  }
  return [...new Set(out.filter(Boolean))];
}

export function loadArt(artRoot, styleKey, { log = () => {} } = {}) {
  const manifestPath = join(artRoot, 'manifest.json');
  const queuePath = join(artRoot, 'queue.jsonl');
  let cache = { mtime: 0, map: new Map(), style: null, loaded: false, why: 'manifest not read yet' };

  function read(force = false) {
    if (!existsSync(manifestPath)) { cache = { ...cache, why: `no ${manifestPath} - run game/art/pregen.mjs` }; return cache; }
    const mtime = statSync(manifestPath).mtimeMs;
    if (!force && mtime === cache.mtime) return cache;
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const map = new Map();
      for (const a of m.assets || []) if (a && a.id && a.file) map.set(a.id, a);
      cache = { mtime, map, style: m.style, loaded: true, why: null, schema: m.schema };
      log(`art manifest: ${map.size} assets, style ${m.style}`);
    } catch (e) {
      // A half-written manifest is worse than no manifest only if it is invisible.
      cache = { ...cache, why: `manifest unreadable: ${e.message}` };
      log(`art manifest unreadable: ${e.message}`);
    }
    return cache;
  }

  /**
   * @param style optional preferred style directory; the manifest mixes styles because it merges by id
   * @returns {{url:string,file:string,id:string,style:string,style_matches:boolean}|null}
   */
  function resolve(job, opts = {}) {
    const c = read();
    if (!c.loaded) return null;
    const want = opts.style || c.style;
    const ids = candidateIds(job);
    // Two passes: the requested style first, then anything that exists at all. A style whose batch has not
    // been rendered must not look like a missing asset, and it must not pretend the style applied either -
    // callers get `style` (what actually served) and `style_matches` and decide what the player is told.
    for (const pass of [0, 1]) {
      for (const id of ids) {
        const a = c.map.get(id);
        if (!a) continue;
        const inStyle = !want || String(a.file).startsWith(`${want}/`);
        if (pass === 0 ? !inStyle : inStyle) continue;
        const file = join(artRoot, normalize(a.file));
        const rootAbs = pathResolve(artRoot);
        const target = pathResolve(file);
        if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
          log(`refusing art path outside the art dir: ${a.file}`);
          return null;
        }
        if (!existsSync(file)) { log(`manifest lists ${id} but the file is gone: ${a.file}`); return null; }
        return { url: `/art/${a.file}`, file, id, style: String(a.file).split('/')[0], style_matches: inStyle };
      }
    }
    return null;
  }

  /**
   * A miss is not a failure, it is work for the next batch. Recorded so `node game/art/pregen.mjs`
   * has something to grow into and so the UI can say "not drawn yet" instead of showing nothing.
   */
  async function miss(job) {
    const c = read();
    await mkdir(artRoot, { recursive: true });
    const rec = { at: new Date().toISOString(), style: (c.style || styleKey), subject_id: job.subject_id, kind: job.kind, name: job.name || null, asked_for: candidateIds(job), why: c.loaded ? 'not_in_manifest' : 'no_manifest' };
    await appendFile(queuePath, JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  }

  /** How many rendered assets each style actually has. The menu reads this and says "0 rendered"
   *  rather than offering a style that would silently serve another style's pictures. */
  function byStyle() {
    const c = read(); const out = {};
    for (const a of c.map.values()) { const k = String(a.file).split('/')[0]; out[k] = (out[k] || 0) + 1; }
    return out;
  }

  return { resolve, miss, byStyle, reload: () => read(true), get status() { const c = read(); return { loaded: c.loaded, assets: c.map.size, style: c.style, why: c.why }; } };
}

// readFileSync comes from node:fs with the other sync friends; there is no second loader here, and the
// first draft of this file invented one because I reached for require in an ESM module. Node said no.
