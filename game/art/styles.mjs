// Art style registry. A style is one @artist tag appended to the positive prompt, which is the only
// reason this is a settings menu and not four workflows: the subject, size, step count, sampler and
// negative prompt are all shared, so picking a style changes exactly one thing.
//
// Ranked by Blarmo, 2026-11-09: Shinkai, Bengal, Gerph, Minillustration. `mita` was rendered in the
// bake-off and not ranked, so it is not offered - an option nobody chose is noise in a menu. When a
// painterly style arrives (Blarmo's note: Anima gives cartoon/anime without help, so that wants a
// LoRA), it is an entry here plus a batch, not a new code path.
export const ART_STYLES = [
  // New engine, new head of the table. Not comparable to the four below by rank: those were ranked on
  // Anima renders at 640px, this is Qwen Image 2.1 at 1MP with real alpha and legible text. `engine` is
  // recorded per style so a menu can grey out what the current build cannot render rather than pretending
  // every style is reachable from every pipeline.
  { key: 'finnstark', rank: 1, label: 'Anato Finnstark', tag: 'Anato Finnstark fantasy illustration with bold linework', engine: 'qwen-image',
    note: 'chosen for the shipped set; bold ink outline, hatched tone, transparent cut-outs' },
  { key: 'shinkai', rank: 2, label: 'Makoto Shinkai', tag: '@makoto_shinkai style', engine: 'anima',
    note: 'ranked first of the Anima bake-off; saturated light, clean linework' },
  { key: 'bengal', rank: 3, label: 'Bengal comic', tag: 'Bengal comic illustration', engine: 'anima',
    note: 'ranked second; not an @artist tag, a style phrase' },
  { key: 'gerph', rank: 4, label: 'Gerph', tag: '@gerph style', engine: 'anima',
    note: 'ranked third' },
  { key: 'mini', rank: 5, label: 'Minillustration', tag: '@minillustration style', engine: 'anima',
    note: 'ranked fourth' },
];

export const DEFAULT_STYLE = 'finnstark';

/** Never throws on an unknown key: a save file from a build with a different menu must still play. */
export function resolveStyle(key) {
  const hit = ART_STYLES.find((s) => s.key === key);
  return hit || ART_STYLES.find((s) => s.key === DEFAULT_STYLE) || ART_STYLES[0];
}

/** Appended to the subject prompt. Empty for a style that deliberately adds no tag. */
export function styleTag(key) {
  return resolveStyle(key).tag || '';
}

/**
 * Every asset carries the style it was made with. Without this, changing the menu mid-gallery gives a
 * room full of half Shinkai, half Bengal cards and no way to tell which is which or which batch to redo.
 */
export function assertStyleTagged(asset) {
  if (!asset || !asset.style) throw new Error(`art asset is not style-tagged: ${JSON.stringify(asset && asset.id)}`);
  return asset;
}
