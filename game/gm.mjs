// The GM turn, host-neutral. One implementation, two hosts.
//
// This code used to live inside .pi/extensions/pi-gm/index.ts. The browser game client needs the exact
// same turn that extension runs, and a second copy of a turn state machine is how a project ends up with
// two rulesets that disagree about what a round costs. So: the pi extension imports from here, and so
// does game/server.mjs. There is no third host and no third way to change the world.
//
// Still true after the move, and this is the part that matters: this file contains ZERO game logic. No
// tier table, no stat maths, no idea what iron is worth, no idea whether a claim was won. It formats a
// prompt, asks a model for a contract, and hands that contract to resolveRound() in tracker/engine.js,
// which is the only thing in the repo allowed to change anything.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveRound, rulesForCall, mutationHash } from '../tracker/engine.js';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SCHEMA_PATH = `${ROOT}game/schema/resolve_round.schema.json`;
export const RULES_PATH = `${ROOT}rules/rules.md`;

export const SLOT_NAMES = ['Bram', 'Ash', 'Sable', 'Piper'];
export const STARTING_KIT = { wood: 3, sinew: 2, ochre: 1 };

/** Slice 1 persona. Deliberately four lines: the harness is the contract, the persona is not. */
export const PERSONA = `You are the Game Master of Dungeon Blaster, a tabletop adventure for four players on one couch.
You are a storyteller at a table. The players hear a voice and see pictures; they never see numbers, files, or menus, and you never read a stat line aloud.
You cannot change the world. Only the tracker can, and only when you ask it in exactly one resolve_round call per round.
Anything you assert about the world becomes law the moment the tracker hears it, so say only what you can pay for.`;

const MUTATIONS_FOR_PROMPT = [
  { tool: 'craft_item' }, { tool: 'take_item' }, { tool: 'transfer_item' },
  { tool: 'move_to' }, { tool: 'award_xp' }, { tool: 'introduce_npc' },
];

export function loadSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
}

export function dmUrl() {
  return process.env.DB_DM_URL || 'http://127.0.0.1:8080';
}

let modelId = null;
/** The server picks its own model name; DB_DM_MODEL overrides for the rare multi-model box. */
export async function dmModel() {
  if (modelId) return modelId;
  const forced = process.env.DB_DM_MODEL;
  if (forced) return forced;
  try {
    const r = await fetch(`${dmUrl()}/v1/models`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    modelId = j?.data?.[0]?.id || 'local';
  } catch {
    modelId = 'local';
  }
  return modelId;
}

/**
 * One DM completion, and the caller gets back a parsed contract or null.
 *
 * response_format json_schema because bare json_object measured 0/4 compliance on this model (it echoes
 * party state instead of following the schema), and native tool calling costs ~730 extra prompt tokens of
 * cold prefill per turn. Reasoning stays off because the budget is first audio, and reasoning burns that
 * budget before a word is spoken.
 *
 * `complete` is injectable so the whole turn - retry, gate, fallback - is testable without a GPU, and so
 * the alpha can run with --fake-dm on a machine that has no model loaded yet.
 */
export async function dmComplete(messages, { signal, schema, log } = {}) {
  const res = await fetch(`${dmUrl()}/v1/chat/completions`, {
    method: 'POST',
    signal: signal || AbortSignal.timeout(180_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: await dmModel(),
      messages,
      temperature: Number(process.env.DB_DM_TEMPERATURE || 0.8),
      max_tokens: Number(process.env.DB_DM_MAX_TOKENS || 900),
      chat_template_kwargs: { force_reasoning: false },
      response_format: { type: 'json_schema', json_schema: { name: 'resolve_round', strict: true, schema } },
    }),
  });
  if (!res.ok) throw new Error(`DM endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (log && body?.timings) log.tokens_out = body.timings.prediction_count ?? null;
  if (!text) throw new Error('DM returned no content');
  try {
    return JSON.parse(text);
  } catch {
    return null; // unparseable is a contract violation, not a crash
  }
}

export function stateSnapshot(g) {
  const lines = [`Round ${g.round}. The party is at ${g.locations[g.party_location].name}.`];
  for (const ch of Object.values(g.characters)) {
    const inv = Object.keys(ch.inventory).map((id) => g.items[id].name);
    const mats = Object.entries(ch.materials).filter(([, q]) => q > 0).map(([n, q]) => `${n} x${q}`);
    lines.push(`Slot ${ch.slot}: ${ch.name}, level ${ch.level} ${ch.class_label}. Carrying: ${inv.join(', ') || 'nothing'}. Materials: ${mats.join(', ') || 'none'}.`);
  }
  const here = g.locations[g.party_location];
  lines.push(`Loot here: ${here.loot.map((l) => `${l.name} x${l.qty}`).join(', ') || 'nothing'}. Exits: ${here.connections.map((c) => g.locations[c].name).join(', ')}.`);
  return lines.join('\n');
}

export function contractNote(extra) {
  return [
    'Call resolve_round exactly once. Emit narration first, then the mutations that pay for it.',
    'Every mutation must carry a unique id, the tool name, the actor slot that requested it (1-4, or null for world changes), and the intent id it implements. An actor can only be moved by an intent that slot actually issued this round.',
    'Materials must use the exact names in the rules, in quantities the actor actually holds. You may not propose stats, tiers, prices, or contention winners; the tracker computes them from what you pay.',
    'Keep narration to two or three spoken sentences. Do not describe anything your mutations do not create.',
    extra,
  ].filter(Boolean).join('\n');
}

/**
 * Barks: lines that cannot be wrong. When the gate withholds narration it is not offering a gap in the
 * audio, it is refusing to state a fact it did not verify - so the replacement has to be pure atmosphere.
 * Anything with a noun and a verb in it could contradict the tracker, which is the whole thing being gated.
 */
export const BARK_PARTIAL = [
  'The dust settles, and not all of it settles where it was promised.',
  'Something happens. Somewhat less than something happens.',
  'The moment lands, scuffed at the edges.',
];
export const BARK_NOTHING = [
  'Nothing happens.',
  'The table waits.',
  'Silence, of the unhelpful kind.',
];

/** What the players hear when the gate would not release the model's sentence. Never null. */
export function barkFor(turnLog, pick = Math.random) {
  if (turnLog?.narration) return null;
  const bank = turnLog?.mode === 'fallback' ? BARK_PARTIAL : BARK_NOTHING;
  return bank[Math.floor(pick() * bank.length)];
}

/**
 * The turn: propose, gate, and at most one retry. A failed strict attempt commits nothing and speaks
 * nothing; the second failure falls back to committing the valid subset with the narration withheld.
 *
 * PROMPT LAYOUT IS A MEASURED CONSTRAINT, NOT A TIDY-UP (notes/probe_d2_stateedit.py, 16K context on the
 * shipping artifact): cold eval 150s, a reused turn 0.8s, and one changed digit ANYWHERE inside the cached
 * prefix costs the full 151s - worse than cold, and --cache-reuse does not rescue a deep edit. So:
 *   1. system holds the persona only and never varies;
 *   2. the rules block is the second message, identical for every round of a campaign;
 *   3. everything mutable - round number, party snapshot, this round's intents - is the NEWEST message.
 * test/turn_test.mjs asserts that second attempts keep byte-identical prefixes, because this is the kind
 * of thing that regresses as a one-character "improvement" to the persona and costs 151s per round.
 */
export async function runTurn(g, { ctx = {}, fallback = true, complete = dmComplete, gate = resolveRound, schema = loadSchema(), notify = () => {} } = {}) {
  const intents = g.intents;
  const needed = rulesForCall(g, MUTATIONS_FOR_PROMPT);

  const stable = [
    { role: 'system', content: PERSONA },
    { role: 'user', content: `<rules>\n${needed.prompt}\n</rules>` },
  ];
  const mutableTail = () => ({
    role: 'user',
    content: `== STATE (authoritative) ==
${stateSnapshot(g)}

Intentions this round:
${intents.map((i) => `[${i.id}] slot ${i.slot}: ${i.text}`).join('\n') || '(nobody said anything)'}

${contractNote()}`,
  });

  let attempt = 1;
  let messages = [...stable, mutableTail()];
  let call = null;
  let result = null;
  let firstHash = null;
  const attempts = [];

  while (attempt <= 2) {
    notify(`DM turn, attempt ${attempt}...`, 'info');
    const log = {};
    const proposal = await complete(messages, { signal: ctx.signal, schema, log, attempt });
    attempts.push({ attempt, messages: messages.map((m) => ({ ...m })), log });
    if (!proposal) {
      messages = [...messages, { role: 'user', content: 'That was not valid JSON matching the contract. Try again.' }];
      attempt += 1;
      continue;
    }
    call = proposal;
    // Identical-hash early-out (tools.md §3): one retry per round, and if the retry proposes the
    // same mutations as the first attempt it learned nothing - stop and take the deterministic
    // fallback instead of spending a gate and a decode on a repeat. `result` stays the first
    // attempt's rejection, so the fallback below runs on this call.
    const hash = mutationHash(call.mutations);
    if (firstHash !== null && hash === firstHash) {
      notify('retry repeats the first attempt verbatim - taking the fallback', 'warn');
      break;
    }
    if (firstHash === null) firstHash = hash;
    // `gate` is injectable for exactly one reason: the early-out is invisible from outside unless a test can
    // count gate evaluations, and a law nobody can count is a law a refactor can delete silently. My own
    // extraction of the turn dropped the early-out and 107 tests stayed green, because the only coverage
    // was on mutationHash itself. Deleting the early-out now turns test/turn_test.mjs red by name.
    result = gate(g, call, { mode: 'strict', rules_refs: needed.refs });
    if (result.ok) break;
    // Reject loudly, then give the model its errors back with the allowed values attached.
    const feedback = result.rejected.map((r) => `${r.id} ${r.code}: ${r.reason}${r.allowed ? ` allowed: ${r.allowed.join(', ')}` : ''}`).join('\n');
    notify(`attempt ${attempt} rejected: ${result.rejected.map((r) => `${r.code}(${r.id})`).join(', ')}`, 'warn');
    // Appended AFTER the mutable tail. Rewriting anything already in the prefix is a 151s re-eval wearing
    // the mask of an error message, so the correction is a new turn like any other.
    messages = [...messages,
      { role: 'assistant', content: JSON.stringify(call) },
      { role: 'user', content: `The tracker rejected this round:\n${feedback}\n\n${contractNote('Fix only what was rejected. Narration must match what actually happens.')}` }];
    attempt += 1;
  }

  if (result && !result.ok && fallback && call) {
    // Second failure: commit what is valid, drop what is not, and let the DM hear the difference.
    result = resolveRound(g, call, { mode: 'fallback', rules_refs: needed.refs });
    const dropped = result.rejected.map((r) => `${r.code}: ${r.reason}`).join(' ');
    result.narration_dropped = dropped;
  }
  return { call, result, rules_refs: needed.refs, attempts };
}
