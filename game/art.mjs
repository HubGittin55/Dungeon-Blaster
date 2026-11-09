// Pre-generated art resolution. One job goes in, one viewable URL comes out or an explicit reason
// comes out - never a silent null, because a blank card and a broken card look identical on a couch.
//
// The manifest is the record of a batch that already ran (game/art/pregen.mjs writes it), so this file
// owns no truth about what art exists; it reads what is on disk, and reloads when the file changes so
// iterating on a bad card does not need a server restart.
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';

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

  /** @returns {{url:string,file:string,id:string}|null} */
  function resolve(job) {
    const c = read();
    if (!c.loaded) return null;
    for (const id of candidateIds(job)) {
      const a = c.map.get(id);
      if (!a) continue;
      const file = join(artRoot, normalize(a.file));
      // A manifest entry that escapes the art directory is a bug in whatever wrote it, and the answer is
      // to refuse loudly rather than to serve /etc/passwd with a smile.
      // Compare RESOLVED forms. Comparing strings is what broke first time: the caller passes
      // "C:/repo/game/art", join() hands back "C:\repo\game\art\shinkai\mat_iron.png", and a prefix test
      // against the un-normalised root refused the one asset the manifest was right about - so the guard
      // designed to stop traversal became a guard that stopped the art.
      const rootAbs = resolve(artRoot);
      const target = resolve(file);
      if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
        log(`refusing art path outside the art dir: ${a.file}`);
        return null;
      }
      if (!existsSync(file)) { log(`manifest lists ${id} but the file is gone: ${a.file}`); return null; }
      return { url: `/art/${a.file}`, file, id };
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

  return { resolve, miss, reload: () => read(true), get status() { const c = read(); return { loaded: c.loaded, assets: c.map.size, style: c.style, why: c.why }; } };
}

// readFileSync comes from node:fs with the other sync friends; there is no second loader here, and the
// first draft of this file invented one because I reached for require in an ESM module. Node said no.
