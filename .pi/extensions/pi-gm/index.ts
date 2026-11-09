/**
 * Dungeon Blaster game-master harness (Slice 1: harness and law).
 *
 * This extension is the harness, not the rules. It owns the turn state machine, calls the DM model, and
 * hands every proposal to the tracker's gate. It contains zero game logic: no tier table, no stat maths,
 * no idea what iron is worth. That lives in rules/rules.md and tracker/engine.js.
 *
 * Two ways to be the DM, one chokepoint:
 *   /dm_round        the extension drives the model endpoint directly (headless, repeatable, testable)
 *   resolve_round    the tool registered below, for when a pi agent plays the DM interactively
 * Both call resolveRound() in the tracker. There is no third way to change the world, and no mutation
 * path that does not go through the gate.
 */

// @ts-ignore - loaded through jiti; the tracker is plain ESM JavaScript at ../../tracker
import {
  newGame, joinSlot, addMaterials, setIntents, resolveRound, rulesForCall, saveGame, loadGame, validateName,
} from '../../../tracker/engine.js';
// @ts-ignore
import { loadRules } from '../../../tracker/rules_doc.js';
// The turn itself lives in game/gm.mjs. It moved there the day the browser client needed the same turn
// this extension runs; a second copy of a turn state machine is how two hosts end up disagreeing about
// what a round costs, which is the one thing Slice 1 exists to prevent.
// @ts-ignore
import { runTurn as runTurnShared } from '../../../game/gm.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCHEMA_PATH = `${ROOT}game/schema/resolve_round.schema.json`;
const RULES_PATH = `${ROOT}rules/rules.md`;

const DM_URL = process.env.DB_DM_URL || 'http://127.0.0.1:8080';
const DM_MODEL = process.env.DB_DM_MODEL || '';
const DM_TEMPERATURE = Number(process.env.DB_DM_TEMPERATURE || 0.8);
const DM_MAX_TOKENS = Number(process.env.DB_DM_MAX_TOKENS || 900);

const SLOT_NAMES = ['Bram', 'Ash', 'Sable', 'Piper'];

let game = null;
let rules = null;
let schema = null;
let skipped = new Set(); // slots auto-skipped each round (NOT the bridge AFK mode)

function ensureRules() {
  rules ||= loadRules(RULES_PATH);
  schema ||= JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  return rules;
}


/**
 * Barks: lines that cannot be wrong. When the gate withholds narration it is not offering a gap in the
 * audio, it is refusing to state a fact it did not verify - so the replacement has to be pure atmosphere.
 * Anything with a noun and a verb in it could contradict the tracker, which is the whole thing being gated.
 */
const BARK_PARTIAL = [
  'The dust settles, and not all of it settles where it was promised.',
  'Something happens. Somewhat less than something happens.',
  'The moment lands, scuffed at the edges.',
];
const BARK_NOTHING = [
  'Nothing happens.',
  'The table waits.',
  'Silence, of the unhelpful kind.',
];

/** Voice is not Slice 1, but the seam has to exist now or it will be welded shut later. */
function speak(text) {
  const url = process.env.DB_TTS_URL;
  if (!url || !text) return;
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice: 'dm' }),
  }).catch(() => { /* silence is a valid Slice 1 outcome; the game must never hang on audio */ });
}

function queueArt(g, jobs, ctx) {
  for (const j of jobs || []) {
    ctx.ui?.notify?.(`art queued: ${j.kind} ${j.subject_id} (${j.size.join('x')}, ${j.steps} steps)`, 'info');
  }
}

/** Delegates to the single shared turn (game/gm.mjs) - see the note on the import above. */
async function runTurn(g, ctx, { fallback = true } = {}) {
  return runTurnShared(g, { ctx, fallback, schema, notify: (m, k) => ctx.ui?.notify?.(m, k) });
}

function statusLine(g) {
  if (!g) return 'no campaign';
  const slots = [1, 2, 3, 4].map((s) => {
    const c = g.characters[s];
    if (!c) return `${s}:-`;
    const ready = g.intents.find((i) => i.slot === s) ? 'spoke' : skipped.has(s) ? 'skipped' : 'quiet';
    const items = Object.keys(c.inventory).map((id) => g.items[id].name);
    return `${s}:${c.name} L${c.level} ${ready} [${items.join(', ') || 'empty'}]`;
  });
  return `round ${g.round} @ ${g.locations[g.party_location].name}\n${slots.join('\n')}`;
}

// ------------------------------------------------------------------ commands

export default function (pi) {
  ensureRules();

  pi.registerTool({
    name: 'resolve_round',
    label: 'Resolve round',
    description:
      'The only way anything changes in Dungeon Blaster. Emit narration first, then the mutations that pay for it. ' +
      'The tracker validates every mutation against the rules and the actors that issued them; a rejected round commits nothing.',
    promptSnippet: 'Resolve a Dungeon Blaster round: narration plus the mutations that pay for it',
    promptGuidelines: [
      'Call resolve_round once per round; it is the only mutation and narration channel in Dungeon Blaster.',
      'Cite the intent id and actor slot for every slot-scoped mutation in resolve_round; never act for a player who did not speak.',
      'Name materials exactly as the rules name them, and never propose stats, tiers, prices, or contention outcomes in resolve_round.',
    ],
    // Hand-written JSON Schema (TypeBox compiles to the same shape) so the extension needs no imports.
    parameters: schema,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!game) return { content: [{ type: 'text', text: 'NO_CAMPAIGN: start one with /dm_new' }] };
      // Advance the round and re-seed the contention order, exactly as /dm_round does: the
      // interactive tool IS a round, so it must consume a round number and a fresh order seed.
      // Without this the round and order seed never advance on the interactive path.
      setIntents(game, game.intents.filter(Boolean).map((i) => ({ ...i })), {});
      const res = resolveRound(game, params, { mode: 'strict', rules_refs: rulesForCall(game, params.mutations || []).refs });
      queueArt(game, res.art_jobs, ctx);
      const text = res.ok
        ? `COMMITTED ${res.committed.length} mutation(s). ${res.committed.map((c) => c.tool).join(', ') || 'none'}`
        : `REJECTED\n${res.rejected.map((r) => `- ${r.id} ${r.code}: ${r.reason}${r.allowed ? ` [allowed: ${r.allowed.join(', ')}]` : ''}`).join('\n')}\nNothing was committed and nothing was said. Fix the rejected mutations and call resolve_round again.`;
      if (res.ok && params.narration) speak(params.narration);
      return { content: [{ type: 'text', text }], details: { round: game.round, rejected: res.rejected, diffs: res.diffs } };
    },
  });

  pi.registerCommand('dm_new', {
    description: 'Start a new Dungeon Blaster campaign (tracker owns the world)',
    handler: async (args, ctx) => {
      const campaign = (args || '').trim() || `campaign-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`;
      game = newGame(ensureRules(), { campaign });
      skipped = new Set();
      ctx.ui.notify(`/dm_join <1-4> <name> <class> to seat players. /dm_round to play.`, 'info');
      ctx.ui.notify(statusLine(game), 'info');
      persist(ctx, game);
    },
  });

  pi.registerCommand('dm_join', {
    description: 'Seat a character in a slot: /dm_join 1 Bram smith',
    handler: async (args, ctx) => {
      if (!game) return ctx.ui.notify('Start with /dm_new', 'error');
      const [slotRaw, ...rest] = (args || '').trim().split(/\s+/);
      const slot = Number(slotRaw);
      if (![1, 2, 3, 4].includes(slot)) return ctx.ui.notify('slot must be 1-4', 'error');
      if (game.characters[slot]) return ctx.ui.notify(`slot ${slot} already holds ${game.characters[slot].name} - it does not change mid-run`, 'error');
      const name = rest[0] || SLOT_NAMES[slot - 1];
      const cls = rest.slice(1).join(' ') || 'wanderer';
      const check = validateName(game, name, 'npc_name');
      if (!check.ok) return ctx.ui.notify(`name rejected: ${check.reason}`, 'error');
      const ch = joinSlot(game, slot, { name, class_label: cls });
      addMaterials(game, slot, { wood: 3, sinew: 2, ochre: 1 }, 'starting kit');
      ctx.ui.notify(`slot ${slot}: ${ch.name} the ${cls} sits down (level ${ch.level})`, 'info');
      persist(ctx, game);
    },
  });

  pi.registerCommand('dm_kit', {
    description: 'Grant materials to a slot (Slice 1 has no economy): /dm_kit 1 iron 4 steel 2',
    handler: async (args, ctx) => {
      if (!game) return ctx.ui.notify('Start with /dm_new', 'error');
      const parts = (args || '').trim().split(/\s+/);
      const slot = Number(parts[0]);
      const mats = {};
      for (let i = 1; i + 1 < parts.length; i += 2) mats[parts[i]] = Number(parts[i + 1]);
      try {
        addMaterials(game, slot, mats, 'dm_kit (dev grant)');
      } catch (e) {
        return ctx.ui.notify(String(e.message || e), 'error');
      }
      ctx.ui.notify(`slot ${slot} now holds: ${Object.entries(game.characters[slot].materials).filter(([, q]) => q > 0).map(([n, q]) => `${n} x${q}`).join(', ')}`, 'info');
      persist(ctx, game);
    },
  });

  pi.registerCommand('dm_intent', {
    description: 'Queue what a slot says they do: /dm_intent 2 I pry the lock',
    handler: async (args, ctx) => {
      if (!game) return ctx.ui.notify('Start with /dm_new', 'error');
      const m = (args || '').trim().match(/^(\d)\s+(.+)$/);
      if (!m) return ctx.ui.notify('usage: /dm_intent <1-4> <text>', 'error');
      const slot = Number(m[1]);
      if (!game.characters[slot]) return ctx.ui.notify(`slot ${slot} is empty`, 'error');
      const existing = game.intents.find((i) => i.slot === slot);
      if (existing) existing.text = m[2].slice(0, 400);
      else game.intents.push({ id: `i${slot}_${game.round + 1}`, slot, text: m[2].slice(0, 400), ready: true });
      ctx.ui.notify(`[${game.intents.find((i) => i.slot === slot).id}] ${game.characters[slot].name}: ${m[2]}`, 'info');
    },
  });

  // Per-slot auto-skip, named dm_skip on purpose: the old name dm_afk collided with the
  // Pi-Stunkus bridge's AFK mode (Blarmo away from the keyboard), which is a different thing
  // entirely and lives in another repo. This one only ever means "this player slot is absent".
  pi.registerCommand('dm_skip', {
    description: 'Auto-skip a slot every round (absent player): /dm_skip 3',
    handler: async (args, ctx) => {
      if (!game) return ctx.ui.notify('Start with /dm_new', 'error');
      const slot = Number((args || '').trim());
      if (!Number.isInteger(slot)) return ctx.ui.notify('usage: /dm_skip <1-4>', 'error');
      if (skipped.has(slot)) { skipped.delete(slot); return ctx.ui.notify(`slot ${slot} is back`, 'info'); }
      skipped.add(slot);
      ctx.ui.notify(`slot ${slotLabel(slot)} is now skipped - the DM narrates over them`, 'info');
    },
  });

  pi.registerCommand('dm_round', {
    description: 'Run one round, or n rounds: /dm_round [n]. Skipped slots auto-skip.',
    getArgumentCompletions: (prefix) => {
      const items = ['1', '2', '5', '10'].map((v) => ({ value: v, label: `rounds: ${v}` }));
      const f = items.filter((i) => i.value.startsWith(prefix));
      return f.length ? f : null;
    },
    handler: async (args, ctx) => {
      if (!game) return ctx.ui.notify('Start with /dm_new', 'error');
      const n = Math.min(20, Math.max(1, Number((args || '').trim()) || 1));
      for (let r = 0; r < n; r++) {
        // Skipped slots never owe an intent; everyone else is expected to have used /dm_intent.
        const quiet = [1, 2, 3, 4].filter((s) => game.characters[s] && !skipped.has(s) && !game.intents.find((i) => i.slot === s));
        if (quiet.length) ctx.ui.notify(`slots ${quiet.join(', ')} issued no intent - the tracker treats them as silent, not absent`, 'info');
        setIntents(game, game.intents.filter(Boolean).map((i) => ({ ...i })), {});
        const { call, result } = await runTurn(game, ctx);
        if (!result) { ctx.ui.notify('DM produced no usable contract after two attempts; the round is dropped', 'error'); continue; }
        for (const d of result.diffs || []) ctx.ui.notify(`  ${d}`, 'info');
        if (result.rejected?.length) ctx.ui.notify(`still rejected after fallback: ${result.rejected.map((x) => `${x.code}(${x.id})`).join(', ')}`, 'warn');
        const narration = result.turn_log?.narration;
        // The engine releases narration only for a round it accepted whole. A fallback round commits a
        // subset, so its sentence describes things that did not happen - and spoken lies cannot be
        // un-spoken. Bark instead: atmosphere is allowed, fabricated facts are not.
        if (!narration) {
          const bank = result.turn_log?.mode === 'fallback' ? BARK_PARTIAL : BARK_NOTHING;
          ctx.ui.notify(`narration withheld (${result.turn_log?.narration_blocked || 'rejected'}); barking`, 'warn');
          speak(bank[Math.floor(Math.random() * bank.length)]);
        }
        if (narration) {
          await pi.sendMessage({ customType: 'dm-narration', content: narration, display: true, details: { round: game.round } }, { triggerTurn: false });
          speak(narration);
        } else {
          ctx.ui.notify('no narration released (round rejected)', 'warn');
        }
        queueArt(game, result.art_jobs, ctx);
        game.intents = [];
        persist(ctx, game);
        ctx.ui.notify(statusLine(game), 'info');
      }
    },
  });

  pi.registerCommand('dm_status', {
    description: 'Tracker state: slots, levels, inventory, position',
    handler: async (_args, ctx) => ctx.ui.notify(game ? statusLine(game) : 'no campaign', 'info'),
  });

  pi.registerCommand('dm_rules', {
    description: 'Show exactly what the DM would be told for a mutation: /dm_rules craft_item',
    handler: async (args, ctx) => {
      ensureRules();
      const tool = (args || 'craft_item').trim();
      const r = rulesForCall(game || newGame(rules, { campaign: 'peek' }), [{ tool }]);
      ctx.ui.notify(`retrieved for ${tool}: ${r.refs.map((x) => `${x.id}@${x.hash}`).join(' ')}\n\n${r.prompt.slice(0, 1400)}`, 'info');
    },
  });

  pi.registerCommand('dm_load', {
    description: 'Load a saved campaign from saves/',
    handler: async (args, ctx) => {
      ensureRules();
      const g = loadGame(rules, (args || '').trim() || 'campaign-1');
      if (!g) return ctx.ui.notify(`no save for that campaign`, 'error');
      game = g;
      ctx.ui.notify(`loaded ${g.campaign} at round ${g.round}`, 'info');
      ctx.ui.notify(statusLine(game), 'info');
    },
  });

  pi.on('session_start', async (_e, ctx) => {
    const entries = ctx.sessionManager.getEntries?.() || [];
    const last = [...entries].reverse().find((e) => e.type === 'custom' && e.customType === 'dm-campaign');
    if (last?.data?.campaign) {
      ensureRules();
      const g = loadGame(rules, last.data.campaign);
      if (g) { game = g; ctx.ui.notify(`resumed ${g.campaign}, round ${g.round}`, 'info'); }
    }
  });

  pi.registerEntryRenderer?.('dm-narration', (entry) => `GM: ${entry.content}`);
}

function slotLabel(slot) {
  return game?.characters?.[slot]?.name || `slot ${slot}`;
}

function persist(ctx, g) {
  saveGame(g);
  pi.appendEntry?.('dm-campaign', { campaign: g.campaign, round: g.round });
  ctx.sessionManager.appendEntry?.('dm-campaign', { campaign: g.campaign, round: g.round });
}
