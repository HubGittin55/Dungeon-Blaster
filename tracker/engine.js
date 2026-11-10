// The tracker: deterministic, source of truth, and the only thing that can change the world.
//
// Slice 1 storage decision (deviates from the architecture doc's "proposed SQLite alone", which was an
// OPEN decision): append-only JSONL events plus a snapshot JSON. Reason is concrete - this box runs
// Node 20, which has no node:sqlite, and better-sqlite3 would need a node-gyp/Visual Studio build
// inside pi's jiti loader. The doc's own justification for SQLite was replay-debugging and tidy saves,
// and both are satisfied by an event log. Migration path: the event stream is the schema; a SQLite
// import is a loader, not a redesign.
//
// Invariants this file owns:
//   - a mutation with no valid actor/intent never applies (per-actor authority boundary)
//   - strict rounds commit nothing when anything is rejected, so nothing can be spoken about a
//     half-applied round; the fallback path commits the valid subset and drops the invalid
//   - the DM never chooses a contention winner; the seed does
//   - stats come out of the budget function, never out of the model

import { appendFileSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { retrieve, renderForPrompt } from './rules_doc.js';

/** Which rules sections each mutation needs in front of the DM. Deterministic, logged. */
export const TOOL_TAGS = {
  craft_item: ['craft', 'tier', 'item', 'material', 'budget', 'naming', 'contention'],
  take_item: ['craft', 'naming', 'contention'],
  drop_item: ['naming'],
  transfer_item: ['transfer', 'contention'],
  move_to: ['movement'],
  award_xp: ['xp'],
  introduce_npc: ['naming', 'item'],
};

const WORLD_SCOPED = new Set(['move_to', 'introduce_npc', 'award_xp']);

export function newGame(rules, { campaign = 'campaign-1' } = {}) {
  return {
    campaign,
    rules,
    round: 0,
    order_seed: '',
    seq: 0,
    party_location: 'start',
    characters: {}, // slot -> Character
    items: {}, // item_id -> Item
    npcs: {},
    locations: {
      start: { id: 'start', name: 'Damp cell', description: 'A door, a drip, and a rumour of stairs.', art_asset_id: null, visited: true, connections: ['corridor'], loot: [] },
      corridor: { id: 'corridor', name: 'Guard corridor', description: 'Torchlight on wet stone.', art_asset_id: null, visited: false, connections: ['start', 'guardroom'], loot: [{ kind: 'material', name: 'iron', qty: 2 }] },
      guardroom: { id: 'guardroom', name: 'Guardroom', description: 'A table, a dice game, and one chair still warm.', art_asset_id: null, visited: false, connections: ['corridor'], loot: [{ kind: 'material', name: 'cloth', qty: 3 }, { kind: 'material', name: 'steel', qty: 1 }] },
    },
    intents: [], // this round: {id, slot, text, ready}
    confirms: new Set(), // "giver:receiver" transfer approvals from the shared screen
    log: [],
    events_path: `saves/${campaign}.events.jsonl`,
  };
}

const get = (s, tag) => s.rules.byId.get(tag);
const tierOf = (rules, name) => {
  const m = get(rules, 'rule.materials').data.materials.find((x) => x.name === name);
  return m ? { ...m } : null;
};
const tierRow = (rules, tier) => get(rules, 'rule.tier.table').data.tiers.find((t) => t.tier === tier);

// Every number the tracker spends is a whole count of a thing, per rules line 52, "No negative
// numbers". Absent means one; anything else is not a quantity. This is not pedantry: while qty was
// read as `Number.isInteger(a.qty) ? a.qty : 1`, `drop qty=-1` ADDED material to the dropper, `take
// qty=-1` conjured loot in the room, and `transfer qty=-1` inflated the sender's stack while emptying
// the receiver's. A negative quantity is not a direction, it is a hole with an argument.
const qtyOf = (v) => (v === undefined || v === null || v === '' ? 1 : (Number.isInteger(v) && v >= 1 ? v : null));
const QTY_ALLOWED = ['qty: a whole number, 1 or more'];

// Within-round balances. The gate validates every mutation against the state at the top of the round
// and then commits the lot, so any pool two mutations draw on has to be counted here or each is legal
// on its own and the pair overdraws: two crafts of 2 wood against 3 in the bag used to end the round
// at wood = -1, and two drops of the same club crashed the commit on the second one. Anything the
// tracker spends is drawn through this ledger, so the second caller sees the first caller's draw.
// A mutation reserves only once every one of its draws fits, or a craft that is refused for want of
// sinew would have quietly spent the party's wood in a round that commits nothing.
function drawFrom(ctx, draws) {
  const left = new Map();
  for (const d of draws) {
    const have = ctx.pool.has(d.key) ? ctx.pool.get(d.key) : d.have;
    const got = left.has(d.key) ? left.get(d.key) : have;
    if (d.need > got) return { ok: false, key: d.key, need: d.need, have };
    left.set(d.key, got - d.need);
  }
  for (const [k, v] of left) ctx.pool.set(k, v);
  return { ok: true };
}

// What an impossible world looks like. This is the backstop, not the law: quantities are checked
// before they are spent, but a pool somebody forgets to count should cost a round, not a run - and in
// a game that is only ever heard, a corrupted number is a corruption the table cannot see. Exported so
// the fuzz test can assert that no soup of mutations ever leaves the state in one of these states.
export function stateInvariants(g) {
  const bad = [];
  for (const ch of Object.values(g.characters || {})) {
    for (const [n, q] of Object.entries(ch.materials || {})) {
      if (!Number.isInteger(q) || q < 0) bad.push(`slot ${ch.slot} holds ${q} ${n}`);
    }
    for (const [id, q] of Object.entries(ch.inventory || {})) {
      if (!Number.isInteger(q) || q < 1) bad.push(`slot ${ch.slot} holds ${q} of item ${id}`);
      if (!g.items || !g.items[id]) bad.push(`slot ${ch.slot} holds unknown item ${id}`);
    }
  }
  for (const [loc, place] of Object.entries(g.locations || {})) {
    for (const l of place.loot || []) if (!Number.isInteger(l.qty) || l.qty < 1) bad.push(`${loc} has a stack of ${l.qty} ${l.name}`);
  }
  // An item has exactly one holder, and its owner agrees with who is holding it. Handing a club to slot
  // 2 while slot 1 still carries five of it is the duplication every quantity check exists to prevent.
  for (const [id, it] of Object.entries(g.items || {})) {
    const holders = Object.values(g.characters || {}).filter((c) => (c.inventory || {})[id] > 0).map((c) => c.slot);
    if (holders.length > 1) bad.push(`item ${id} is carried by ${holders.join(' and ')}`);
    if (it.owner == null && holders.length) bad.push(`item ${id} was dropped and is still carried by ${holders.join(' and ')}`);
    if (Number.isInteger(it.owner) && [1, 2, 3, 4].includes(it.owner) && !holders.includes(it.owner)) {
      bad.push(`item ${id} names owner ${it.owner}, who is not carrying it`);
    }
  }
  return bad;
}

// Commit-time snapshot for that backstop. structuredClone because the state carries Sets and Maps
// (confirms, intents) which JSON would flatten into objects; `rules` is shared, so it is not copied.
function snapshot(g) {
  const snap = {};
  for (const [k, v] of Object.entries(g)) snap[k] = k === 'rules' ? v : structuredClone(v);
  return snap;
}
function restore(g, snap) {
  for (const k of Object.keys(snap)) if (k !== 'rules') g[k] = snap[k];
}

export function joinSlot(g, slot, { name, class_label = 'wanderer', attributes = null } = {}) {
  if (![1, 2, 3, 4].includes(slot)) throw new Error(`slot must be 1-4, got ${slot}`);
  const nameCheck = validateName(g, name, 'npc_name');
  if (!nameCheck.ok) throw new Error(`character name rejected: ${nameCheck.reason}`);
  const law = characterLaw(g);
  const ch = {
    id: `ch_s${slot}`,
    slot,
    name,
    level: 1,
    xp: 0,
    class_label,
    attributes: attributes || defaultAttributes(law),
    sheet: null,
    portrait_asset_id: null,
    voice_notes: '',
    inventory: {}, // item_id -> qty
    materials: {}, // material name -> qty
  };
  g.characters[slot] = ch;
  return ch;
}

/**
 * The character law. `rule.budget` is the gear law and stays that way on purpose: it is also used to size
 * every item, so letting character creation borrow it meant changing a person's maths could silently
 * rebalance a hammer. The two sections are allowed to look similar and must never be the same number.
 */
export function characterLaw(g) { return get(g, 'rule.characters').data; }

/**
 * Is this sheet legal?
 *
 * Checks what the rules say is checkable and nothing else: every point spent (a 9-point sheet is refused,
 * not rounded down), every attribute inside the starting range, no attribute the rules never named, one of
 * the listed classes. Stats themselves are never validated for balance - that is the point of a legal move.
 */
export function validateSheet(g, sheet = {}) {
  const law = characterLaw(g);
  const bad = [];
  const cls = (law.classes || []).find((c) => c.name === sheet.cls);
  if (!cls) bad.push(reject(null, 'UNKNOWN_CLASS', `class must be one of ${law.classes.map((c) => c.name).join(', ')}`));

  const a = sheet.attributes || {};
  const known = law.attributes.map((x) => x.name);
  let spent = 0;
  for (const attr of law.attributes) {
    const v = a[attr.name];
    if (!Number.isInteger(v)) {
      bad.push(reject(null, 'BAD_ATTRIBUTE', `${attr.name} must be a whole number from ${law.min_start} to ${law.max_start}`, [`${attr.name}:${law.min_start}-${law.max_start}`]));
      continue;
    }
    if (v < law.min_start || v > law.max_start) bad.push(reject(null, 'ATTRIBUTE_RANGE', `${attr.name} ${v} is outside ${law.min_start}-${law.max_start}`));
    spent += v;
  }
  const extra = Object.keys(a).filter((k) => !known.includes(k));
  if (extra.length) bad.push(reject(null, 'UNKNOWN_ATTRIBUTE', `not an attribute on a sheet: ${extra.join(', ')}`, known.map((k) => `${k}:1-${law.max_start}`)));
  if (spent !== law.points) bad.push(reject(null, 'POINTS_MISMATCH', `spent ${spent}; a sheet must spend exactly ${law.points}`, [`points:${law.points}`]));

  return bad.length ? { ok: false, rejected: bad } : { ok: true, cls, spent };
}

/**
 * Take a seat with a declared sheet. Player-driven on purpose: the game master is never given a tool that
 * spends someone's points, because a model that can allocate stats is a model that has already won.
 */
export function takeSeat(g, slot, { name, cls, attributes }) {
  // A chair that has already played a round belongs to whoever is sitting in it. Re-declaring would be how
  // you reroll a bad sheet mid-adventure, shrug off your own inventory, or drop a stranger into a body that
  // has been carrying things for six rounds. Before the first round the table is still being built, so a
  // mis-click is fixable; after that the seat is closed.
  const prior = g.characters[slot];
  if (prior && g.round > 0) {
    return { ok: false, rejected: [reject(null, 'SEAT_TAKEN', `${prior.name} sits in slot ${slot}, and the table has played ${g.round} round${g.round === 1 ? '' : 's'}: a character already in play cannot be re-declared`)] };
  }
  const v = validateSheet(g, { cls, attributes });
  if (!v.ok) return v;
  // A name that fails the naming rule is a rejection with the rule attached, not an exception. Throwing
  // meant POST /api/seat answered 500 to "x" as a name, and a 500 is the server admitting it was
  // surprised by something a player typed.
  const nameCheck = validateName(g, name, 'npc_name');
  if (!nameCheck.ok) {
    return { ok: false, rejected: [reject(null, 'NAME_REJECTED', `character name rejected: ${nameCheck.reason}`, nameCheck.allowed)] };
  }
  // An existing character is kept byte-for-byte until the new sheet is proven, because the cap check below
  // can still fail - and "your application was declined" must not be the message that arrives by deleting
  // the character you were already playing.
  const keep = prior ? JSON.parse(JSON.stringify(prior)) : null;
  const ch = joinSlot(g, slot, { name, class_label: cls, attributes: { ...attributes } });
  const law = characterLaw(g);
  for (const [k, n] of Object.entries(v.cls.bonus || {})) ch.attributes[k] = (ch.attributes[k] || 0) + n;
  ch.sheet = { class: cls, trick: v.cls.trick, allocated: { ...attributes }, points: law.points };
  const over = Object.entries(ch.attributes).filter(([, n]) => n > law.max_after_class);
  if (over.length) {
    if (keep) g.characters[slot] = keep; else delete g.characters[slot];
    return { ok: false, rejected: [reject(null, 'ATTRIBUTE_CAP', `${over.map(([k, n]) => `${k} ${n}`).join(', ')} exceeds ${law.max_after_class} after class`)] };
  }
  return { ok: true, character: ch };
}

/**
 * A level-1 sheet is the character law's pool, spread evenly.
 *
 * It used to be four points from the gear budget dumped greedily, which meant every untouched seat walked in
 * with the same lopsided body. Round-robin keeps an uncreated character boring rather than broken, and every
 * point still has to land somewhere legal.
 */
function defaultAttributes(law) {
  const a = {};
  for (const attr of law.attributes) a[attr.name] = law.min_start;
  const names = law.attributes.map((x) => x.name);
  let left = law.points - names.length * law.min_start;
  for (let i = 0; left > 0 && names.some((k) => a[k] < law.max_start); i++) {
    const k = names[i % names.length];
    if (a[k] < law.max_start) { a[k] += 1; left -= 1; }
  }
  return a;
}

export function addMaterials(g, slot, mats, reason = 'starting kit') {
  const ch = g.characters[slot];
  if (!ch) throw new Error(`slot ${slot} has no character`);
  for (const [name, qty] of Object.entries(mats)) {
    if (!tierOf(g, name)) throw new Error(`MATERIAL_UNKNOWN: ${name}`);
    ch.materials[name] = (ch.materials[name] || 0) + qty;
  }
  return { slot, mats, reason };
}

export function setIntents(g, intents, { order_seed } = {}) {
  g.round += 1;
  g.order_seed = order_seed || createHash('sha256').update(`${g.campaign}:${g.round}`).digest('hex').slice(0, 16);
  g.intents = intents.map((i, idx) => ({ id: i.id || `i${i.slot ?? idx + 1}`, slot: i.slot, text: String(i.text ?? '').slice(0, 400), ready: i.ready !== false }));
  return g.intents;
}

export function rulesForCall(g, mutations) {
  const tags = new Set();
  for (const m of mutations || []) for (const t of TOOL_TAGS[m?.tool] || []) tags.add(t);
  const sections = retrieve(g.rules, [...tags]);
  return { sections, refs: sections.map((s) => ({ id: s.id, hash: s.hash })), prompt: renderForPrompt(sections) };
}

/**
 * The gate. `mode: 'strict'` is the normal attempt - all or nothing, because a narration that has been
 * voiced cannot be un-spoken. `mode: 'fallback'` commits the valid subset (the DM stumbles).
 */
export function resolveRound(g, call, { mode = 'strict', rules_refs = [] } = {}) {
  const ctx = {
    g,
    mode,
    accepted: [],
    rejected: [],
    diffs: [],
    art_jobs: [],
    claims: new Map(), // "loc:loot:idx" -> mutation id, first valid claim wins by seed order
    pool: new Map(), // within-round balance ledger: what two mutations could otherwise both spend
    seenCraft: new Map(), // "slot|name|type" -> mutation id, for REJECT_DUPLICATE
  };
  if (!call || typeof call !== 'object' || !Array.isArray(call.mutations) || typeof call.narration !== 'string') {
    return { ok: false, rejected: [{ id: 'call', code: 'BAD_CALL', reason: 'expected {narration: string, mutations: []}' }], committed: [], art_jobs: [], diffs: [], turn_log: null };
  }
  const ms = call.mutations;
  // Deterministic evaluation order: content of the seed decides, never the order the model emitted.
  const ordered = ms.map((m, i) => ({ m, i, key: claimKey(g.order_seed, m, i) })).sort((a, b) => (a.key < b.key ? -1 : 1));

  for (const { m } of ordered) {
    const r = checkMutation(ctx, m);
    if (r) ctx.rejected.push(r); else ctx.accepted.push(m);
  }

  let committed = [];
  let clean = ctx.rejected.length === 0;
  if (clean || mode === 'fallback') {
    // Snapshot, commit, then ask whether the world is still possible. If it is not, the state goes back
    // and the round is refused: the table hears a tracker that said no, not a number that stays wrong
    // for the rest of the run. This is the backstop for a pool this file forgot to count, not a
    // substitute for counting it - every check above should make this unreachable.
    const before = snapshot(g);
    committed = commitAll(ctx);
    const impossible = stateInvariants(g);
    if (impossible.length) {
      restore(g, before);
      committed = [];
      ctx.accepted = [];
      ctx.art_jobs = [];
      ctx.diffs = [];
      clean = false; // an ok:true round that committed nothing is the exact lie this whole file exists to stop
      ctx.rejected.push(reject(null, 'COMMIT_INVALID', `committing that would leave the world impossible: ${impossible.join('; ')}`));
    }
  }

  const turn_log = {
    round: g.round,
    intents: g.intents.map((i) => i.id),
    rules_refs,
    order_seed: g.order_seed,
    mode,
    tool_calls: ms.map((m) => ({ id: m?.id, tool: m?.tool, actor: m?.actor ?? null, intent: m?.intent ?? null })),
    rejected: ctx.rejected,
    committed: committed.map((c) => c.id),
    state_diff: ctx.diffs,
    // The sentence the model wrote describes the round it PROPOSED. In fallback the committed subset is
    // smaller than what was promised, so that sentence can claim things that never happened - and a spoken
    // lie cannot be un-spoken. The gate buffers narration for exactly this reason, so releasing it here was
    // the gate talking itself out of its own rule. Fallback commits quietly and the caller barks.
    narration: clean ? call.narration : null,
    narration_blocked: clean ? null
      : (mode === 'fallback' ? 'fallback_voices_only_what_was_verified' : 'round_rejected'),
  };
  if (mode === 'strict' && !clean) {
    // A failed strict attempt is logged but commits nothing; the retry or fallback follows.
    turn_log.narration = null;
  }
  g.log.push(turn_log);
  appendEvent(g, { type: 'round', ...turn_log });
  return { ok: clean, rejected: ctx.rejected, committed, art_jobs: ctx.art_jobs, diffs: ctx.diffs, turn_log };
}

function claimKey(seed, m, i) {
  return createHash('sha256').update(`${seed}|${m?.id || 'x'}|${i}`).digest('hex').slice(0, 12);
}

/**
 * Normalised mutation hash: a call's mutations reduced to the fields that decide whether the gate
 * would treat them the same (tool, actor, intent, args), with ids and ordering dropped. Two
 * proposals with the same hash are the same ask in different clothes, which is what the one-retry
 * policy in tools.md §3 tests for before spending a gate and a decode on a repeat.
 */
export function mutationHash(mutations) {
  const parts = (mutations || []).map((m) => stableStringify({
    tool: m?.tool ?? null,
    actor: m?.actor ?? null,
    intent: m?.intent ?? null,
    args: m?.args ?? null,
  }));
  parts.sort();
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

function stableStringify(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

function reject(m, code, reason, allowed) {
  const r = { id: m?.id ?? '?', code, reason };
  if (allowed) r.allowed = allowed;
  return r;
}

function checkMutation(ctx, m) {
  const g = ctx.g;
  if (!m || typeof m !== 'object') return reject(m, 'BAD_CALL', 'mutation is not an object');
  if (!m.id || typeof m.id !== 'string') return reject(m, 'BAD_CALL', 'mutation needs a string id');
  if (!TOOL_TAGS[m.tool]) return reject(m, 'BAD_CALL', `unknown tool ${JSON.stringify(m.tool)} - Slice 1 accepts ${Object.keys(TOOL_TAGS).join(', ')}`);

  // Per-actor authority: world mutations need no intent, slot mutations need that slot's intent.
  const actor = m.actor;
  if (WORLD_SCOPED.has(m.tool)) {
    if (actor !== null && actor !== undefined && ![1, 2, 3, 4].includes(actor)) return reject(m, 'SLOT_UNKNOWN', `actor must be 1-4 or null, got ${actor}`);
  } else {
    if (![1, 2, 3, 4].includes(actor)) return reject(m, 'SLOT_UNKNOWN', `${m.tool} needs an actor slot 1-4`);
    if (!g.characters[actor]) return reject(m, 'SLOT_UNKNOWN', `slot ${actor} has no character, so it owes no intent and can spend nothing`);
    const intent = g.intents.find((i) => i.id === m.intent && i.slot === actor);
    if (!intent) {
      // Name the legal values, including when the citation exists but belongs to somebody else: a live model
      // cited another seat's intent twice in a row against this message, burned two 25-second attempts, and
      // the round went to the canned bark. "must cite an intent issued by slot 4" is not a correction when
      // the caller can see four ids and has no way to know which ones are slot 4's.
      const mine = g.intents.filter((i) => i.slot === actor).map((i) => i.id);
      const stolen = g.intents.find((i) => i.id === m.intent);
      const why = stolen
        ? `'${stolen.id}' was issued by slot ${stolen.slot}, not slot ${actor}`
        : m.intent === undefined || m.intent === null ? `no intent was cited` : `'${m.intent}' was not issued this round`;
      return reject(
        m, 'NO_INTENT',
        `${m.tool} must cite an intent issued by slot ${actor} this round (${why})`
        + (mine.length ? `: cite one of ${mine.join(', ')}` : `: slot ${actor} issued nothing, so nothing may be done to it`),
        mine,
      );
    }
  }

  switch (m.tool) {
    case 'craft_item': return checkCraft(ctx, m);
    case 'take_item': return checkTake(ctx, m);
    case 'drop_item': return checkDrop(ctx, m);
    case 'transfer_item': return checkTransfer(ctx, m);
    case 'move_to': return checkMove(ctx, m);
    case 'award_xp': return checkAwardXp(ctx, m);
    case 'introduce_npc': return checkNpc(ctx, m);
  }
}

// --- crafting ---------------------------------------------------------------

function checkCraft(ctx, m) {
  const g = ctx.g;
  const a = m.args || {};
  const mats = Array.isArray(a.materials) ? a.materials : [];
  if (!mats.length) return reject(m, 'MISSING_MATERIAL', 'crafting requires materials the actor already holds', recipeHint(g, a.item_type));

  // Unknown names are refused before a tier can be derived from them.
  for (const mm of mats) {
    if (!mm || typeof mm.name !== 'string' || !Number.isInteger(mm.qty) || mm.qty < 1) {
      return reject(m, 'BAD_ARGS', 'materials need {name, qty:int>=1}');
    }
    if (!tierOf(g, mm.name)) return reject(m, 'MATERIAL_UNKNOWN', `nothing in the rules is called ${JSON.stringify(mm.name)}`, knownMaterialNames(g));
  }

  // Tier is paid for, never proposed.
  const derived = Math.max(...mats.map((mm) => tierOf(g, mm.name).tier));
  if (Number.isInteger(a.tier) && a.tier > derived) {
    return reject(m, 'BAD_ARGS', `${a.materials.map((x) => x.name).join('+')} supports tier ${derived}, not ${a.tier}`, [`tier:${derived}`]);
  }

  // Level gate on the crafter. Owner may be another slot; nobody crafts above their own level.
  const ch = g.characters[m.actor];
  const row = tierRow(g, derived);
  if (ch.level < row.unlock_level) {
    return reject(m, 'TIER_LOCKED', `${row.name} (tier ${derived}) unlocks at level ${row.unlock_level}; slot ${m.actor} is level ${ch.level}`, [`tier:${row.unlock_level - 1}`]);
  }

  // Inventory: exact quantities, exact names, named exactly in the rejection.
  const missing = [];
  for (const mm of mats) {
    const have = ch.materials[mm.name] || 0;
    const want = mats.filter((x) => x.name === mm.name).reduce((s, x) => s + x.qty, 0);
    if (have < want && !missing.some((x) => x.name === mm.name)) missing.push({ name: mm.name, need: want, have });
  }
  if (missing.length) return reject(m, 'MISSING_MATERIAL', `slot ${m.actor} is short of ${missing.map((x) => `${x.name} ${x.need - x.have}`).join(', ')}`, missing.map((x) => `${x.name}:${x.have}`));

  // Recipe shape: `core` units must be of the item tier, `binding` may be anything at or below.
  const types = get(g, 'rule.item.types').data.types;
  const type = types.find((t) => t.name === a.item_type);
  if (!type) return reject(m, 'BAD_ARGS', `item_type must be one of ${types.map((t) => t.name).join(', ')}`);
  const cost = type.cost;
  const pool = [];
  for (const mm of mats) for (let i = 0; i < mm.qty; i++) pool.push(tierOf(g, mm.name));
  const top = pool.filter((x) => x.tier === derived).length;
  const needCore = cost.core || 0, needBind = cost.binding || 0, needFocus = cost.focus || 0;
  if (top < needCore + needFocus) {
    return reject(m, 'MISSING_MATERIAL', `a ${type.name} needs ${needCore + needFocus} tier-${derived} material(s), the recipe supplies ${top}`, [`${derived}-tier:${needCore + needFocus}`]);
  }
  // The focus slot is the one that cannot be satisfied by more of the same: it must lean the way the
  // item's primary attribute leans, which is why a trinket needs silver or a gem, not three sticks.
  if (needFocus) {
    const leans = new Map();
    for (const mm of mats) {
      const mat = tierOf(g, mm.name);
      if (mat.tier === derived && mat.lean === type.primary) leans.set(mat.name, (leans.get(mat.name) || 0) + mm.qty);
    }
    const haveFocus = [...leans.values()].reduce((a, b) => a + b, 0);
    if (haveFocus < needFocus) {
      const wanted = get(g, 'rule.materials').data.materials.filter((x) => x.lean === type.primary && x.tier <= derived).map((x) => `${x.name}:${x.tier}`);
      return reject(m, 'MISSING_MATERIAL', `a ${type.name} needs ${needFocus} ${type.primary}-leaning focus unit(s) of tier ${derived}; the recipe supplies none`, wanted);
    }
  }
  if (pool.length < needCore + needBind + needFocus) {
    return reject(m, 'MISSING_MATERIAL', `a ${type.name} needs ${needCore + needBind + needFocus} material unit(s) in total, the recipe supplies ${pool.length}`, [`units:${needCore + needBind + needFocus}`]);
  }

  const nameCheck = validateName(g, a.name, 'item_name');
  if (!nameCheck.ok) return reject(m, 'BAD_ARGS', `item name rejected: ${nameCheck.reason}`, nameCheck.allowed);

  // One intent crafts one item: an identical second craft from the same actor is double-dipping.
  const dkey = `${m.actor}|${nameCheck.name.toLowerCase()}|${type.name}`;
  const dedup = get(g, 'rule.craft.dedup').data;
  if (dedup.duplicate_call_same_intent_same_round === 'REJECT_DUPLICATE' && ctx.seenCraft.has(dkey)) {
    return reject(m, 'REJECT_DUPLICATE', `slot ${m.actor} already crafts ${nameCheck.name} this round (see ${ctx.seenCraft.get(dkey)})`);
  }
  ctx.seenCraft.set(dkey, m.id);

  // Last check, because it reserves: the material pool is counted across the round, so a second craft
  // that would leave the bag short is refused here rather than committed and found out later.
  const need = new Map();
  for (const mm of mats) need.set(mm.name, (need.get(mm.name) || 0) + mm.qty);
  const fit = drawFrom(ctx, [...need].map(([name, want]) => ({
    key: `mat:${m.actor}:${name}`, need: want, have: ch.materials[name] || 0,
  })));
  if (!fit.ok) {
    const name = fit.key.split(':')[2];
    return reject(m, 'MISSING_MATERIAL', `slot ${m.actor} has ${fit.have} ${name} left once this round's other spends are counted, and ${fit.need} is wanted`, [`${name}:${fit.have}`]);
  }

  ctx.accepted_detail ||= new Map();
  (ctx.accepted_detail.set(m.id, { derived, type, name: nameCheck.name, owner: a.owner_slot ?? m.actor, mats }));
  return null;
}

function commitCraft(ctx, m) {
  const g = ctx.g;
  const d = ctx.accepted_detail.get(m.id);
  const ch = g.characters[m.actor];
  for (const mm of d.mats) {
    ch.materials[mm.name] -= mm.qty;
    ctx.diffs.push(`ch_s${m.actor}.materials.${mm.name}:-${mm.qty}`);
  }
  const stats = computeItemStats(g, d.type, d.derived, d.mats);
  const id = `it_${g.round}_${slug(d.name)}_${++g.seq}`;
  g.items[id] = {
    id, name: d.name, type: d.type.name, tier: d.derived, materials_spent: d.mats.map((x) => ({ ...x })),
    stats: stats.stats, carve: stats.carve, properties: stats.properties, art_asset_id: null,
    created_turn: g.round, owner: d.owner, intent: m.intent,
  };
  const owner = g.characters[d.owner];
  owner.inventory[id] = (owner.inventory[id] || 0) + 1;
  ctx.diffs.push(`item:${id}=+1`);
  ctx.art_jobs.push({ kind: 'item', subject_id: id, prompt_hint: `${d.name}, ${d.type.name}, ${tierRow(g, d.derived).name} fantasy gear, anime RPG card art`, size: [640, 640], steps: 6 });
  return { id, tool: 'craft_item', item: g.items[id] };
}

// --- inventory, movement, progression --------------------------------------

function checkTake(ctx, m) {
  const g = ctx.g;
  const a = m.args || {};
  const loc = g.locations[g.party_location];
  const qty = qtyOf(a.qty);
  if (qty === null) return reject(m, 'BAD_ARGS', 'qty must be a whole number of at least 1 - taking -1 iron is how you plant iron', QTY_ALLOWED);
  const isMat = !!tierOf(g, a.name);
  const idx = loc.loot.findIndex((l) => l.kind === (isMat ? 'material' : 'item') && l.name === a.name);
  if (idx < 0) return reject(m, 'BAD_ARGS', `nothing called ${JSON.stringify(a.name)} is here to take`, loc.loot.map((l) => `${l.name}:${l.qty}`));
  if (loc.loot[idx].qty < qty) return reject(m, 'NOTHING_TAKEN', `only ${loc.loot[idx].qty} ${a.name} left here`);
  const ckey = `${g.party_location}:${idx}`;
  const prior = ctx.claims.get(ckey);
  if (prior) return reject(m, 'CONTENTION_LOSER', `intent ${prior} got there first for the ${a.name}; the seed ${g.order_seed} decided, not the DM`);
  ctx.claims.set(ckey, m.id);
  (ctx.accepted_detail ||= new Map()).set(m.id, { idx, qty, isMat, loc });
  return null;
}

function commitTake(ctx, m) {
  const g = ctx.g;
  const d = ctx.accepted_detail.get(m.id);
  const ch = g.characters[m.actor];
  d.loc.loot[d.idx].qty -= d.qty;
  if (d.loc.loot[d.idx].qty <= 0) d.loc.loot.splice(d.idx, 1);
  ctx.diffs.push(`location:${g.party_location}.loot[${d.idx}]:-${d.qty}`);
  ctx.diffs.push(`ch_s${m.actor}.took:${d.isMat ? d.name : d.name}+${d.qty}`);
  // materials are added by name, items are minted as entities owned by the taker
  if (d.isMat) {
    const nm = m.args.name;
    ch.materials[nm] = (ch.materials[nm] || 0) + d.qty;
  } else {
    const id = `it_${g.round}_${slug(m.args.name)}_${++g.seq}`;
    g.items[id] = { id, name: m.args.name, type: m.args.item_type || 'trinket', tier: 1, materials_spent: [], stats: {}, carve: 0, properties: [], art_asset_id: null, created_turn: g.round, owner: m.actor, intent: m.intent };
    ch.inventory[id] = 1;
    ctx.art_jobs.push({ kind: 'item', subject_id: id, prompt_hint: `${m.args.name}, found item, anime RPG card art`, size: [640, 640], steps: 6 });
  }
  return { id: m.id, tool: 'take_item' };
}

function checkDrop(ctx, m) {
  const g = ctx.g;
  const ch = g.characters[m.actor];
  const a = m.args || {};
  const qty = qtyOf(a.qty);
  if (qty === null) return reject(m, 'BAD_ARGS', 'qty must be a whole number of at least 1 - dropping -1 wood puts wood in your pocket', QTY_ALLOWED);
  const isMat = !!tierOf(g, a.name);
  let itemId = null;
  if (isMat) {
    if ((ch.materials[a.name] || 0) < qty) return reject(m, 'MISSING_MATERIAL', `slot ${m.actor} holds ${(ch.materials[a.name] || 0)} ${a.name}`, [`${a.name}:${ch.materials[a.name] || 0}`]);
  } else {
    itemId = findHeld(g, ch, a.name);
    if (!itemId) return reject(m, 'BAD_ARGS', `slot ${m.actor} is not carrying ${JSON.stringify(a.name)}`, heldNames(g, ch));
    // Dropping more than you hold used to delete the item from existence: the stack went negative, got
    // pruned, and the item lost its owner without ever reaching the room's loot.
    if (ch.inventory[itemId] < qty) return reject(m, 'BAD_ARGS', `slot ${m.actor} holds ${ch.inventory[itemId]} ${a.name}, not ${qty}`, [`qty:1..${ch.inventory[itemId]}`]);
  }
  const fit = drawFrom(ctx, [{
    key: isMat ? `mat:${m.actor}:${a.name}` : `inv:${m.actor}:${itemId}`,
    need: qty,
    have: isMat ? (ch.materials[a.name] || 0) : ch.inventory[itemId],
  }]);
  if (!fit.ok) return reject(m, 'MISSING_MATERIAL', `only ${fit.have} left here once this round's other drops are counted`);
  (ctx.accepted_detail ||= new Map()).set(m.id, { qty, isMat, itemId });
  return null;
}
function commitDrop(ctx, m) {
  const g = ctx.g;
  const d = ctx.accepted_detail.get(m.id);
  const ch = g.characters[m.actor];
  const loc = g.locations[g.party_location];
  if (d.isMat) {
    ch.materials[m.args.name] -= d.qty;
    const l = loc.loot.find((x) => x.kind === 'material' && x.name === m.args.name);
    if (l) l.qty += d.qty; else loc.loot.push({ kind: 'material', name: m.args.name, qty: d.qty });
    ctx.diffs.push(`ch_s${m.actor}.materials.${m.args.name}:-${d.qty}`);
  } else {
    // The item id the gate checked, not a fresh lookup: by commit time an earlier drop in the same round
    // may have emptied the stack, and looking it up again used to return undefined and then try to set
    // `.owner` on nothing. The engine throwing mid-commit is the one failure a table cannot recover from.
    const id = d.itemId;
    ch.inventory[id] -= d.qty;
    if (ch.inventory[id] <= 0) delete ch.inventory[id];
    g.items[id].owner = null;
    ctx.diffs.push(`item:${id}:-${d.qty}`);
  }
  return { id: m.id, tool: 'drop_item' };
}

function checkTransfer(ctx, m) {
  const g = ctx.g;
  const a = m.args || {};
  const to = a.to_slot;
  if (![1, 2, 3, 4].includes(to) || !g.characters[to]) return reject(m, 'SLOT_UNKNOWN', `to_slot ${to} has no character`);
  if (to === m.actor) return reject(m, 'BAD_ARGS', 'cannot transfer to yourself');
  // Architecture doc: transfer needs the owner's confirm keypress on the shared screen, plus an intent
  // from both sides. The giver's intent is the one cited; the receiver's is checked here.
  const recvIntent = g.intents.find((i) => i.slot === to);
  if (!recvIntent) return reject(m, 'NO_INTENT', `receiving slot ${to} issued no intent this round`);
  if (!g.confirms.has(`${m.actor}:${to}`)) return reject(m, 'BAD_ARGS', `slot ${to} has not pressed confirm for this transfer`);
  const ch = g.characters[m.actor];
  const qty = qtyOf(a.qty);
  if (qty === null) return reject(m, 'BAD_ARGS', 'qty must be a whole number of at least 1 - a transfer of -1 wood is a duplication, not a direction', QTY_ALLOWED);
  const isMat = !!tierOf(g, a.name);
  let itemId = null;
  if (isMat) {
    if ((ch.materials[a.name] || 0) < qty) return reject(m, 'MISSING_MATERIAL', `slot ${m.actor} holds ${(ch.materials[a.name] || 0)} ${a.name}`);
  } else {
    itemId = findHeld(g, ch, a.name);
    if (!itemId) return reject(m, 'BAD_ARGS', `slot ${m.actor} is not carrying ${JSON.stringify(a.name)}`, heldNames(g, ch));
    // A unique item changed hands in fives: handing across a club held once, `qty 5`, moved five of it
    // and left the giver holding zero of an item that had one of anything.
    if (ch.inventory[itemId] < qty) return reject(m, 'BAD_ARGS', `slot ${m.actor} holds ${ch.inventory[itemId]} ${a.name}, not ${qty}`, [`qty:1..${ch.inventory[itemId]}`]);
  }
  const key = `${m.actor}:${to}`;
  if (!g.confirms.has(key)) return reject(m, 'BAD_ARGS', `slot ${to} has not pressed confirm for this transfer`);
  const fit = drawFrom(ctx, [{
    key: isMat ? `mat:${m.actor}:${a.name}` : `inv:${m.actor}:${itemId}`,
    need: qty,
    have: isMat ? (ch.materials[a.name] || 0) : ch.inventory[itemId],
  }]);
  if (!fit.ok) return reject(m, 'MISSING_MATERIAL', `slot ${m.actor} has ${fit.have} left to give once this round's other gifts are counted`);
  // The press is spent at commit, not in this check. A transfer refused three lines above was never a
  // handoff anybody agreed to, and making a partner press again for the tracker's own decision is a tax
  // on a round that committed nothing. (Doors and closures run the other way by rule - see the
  // disarm/unwedge/relight checks, where a rejected attempt spends the press on purpose.)
  (ctx.accepted_detail ||= new Map()).set(m.id, { qty, to, isMat, itemId, confirmKey: key });
  return null;
}
function commitTransfer(ctx, m) {
  const g = ctx.g;
  const d = ctx.accepted_detail.get(m.id);
  if (d.confirmKey) g.confirms.delete(d.confirmKey);
  const from = g.characters[m.actor], to = g.characters[d.to];
  if (d.isMat) {
    from.materials[m.args.name] -= d.qty;
    to.materials[m.args.name] = (to.materials[m.args.name] || 0) + d.qty;
    ctx.diffs.push(`ch_s${m.actor}.materials.${m.args.name}:-${d.qty}`);
    ctx.diffs.push(`ch_s${d.to}.materials.${m.args.name}:+${d.qty}`);
  } else {
    const id = d.itemId; // the id the gate checked, for the same reason commitDrop does
    from.inventory[id] -= d.qty;
    if (from.inventory[id] <= 0) delete from.inventory[id];
    to.inventory[id] = (to.inventory[id] || 0) + d.qty;
    g.items[id].owner = d.to;
    ctx.diffs.push(`item:${id}.owner=${d.to}`);
  }
  return { id: m.id, tool: 'transfer_item' };
}

function checkMove(ctx, m) {
  const g = ctx.g;
  const a = m.args || {};
  const here = g.locations[g.party_location];
  const dest = Object.values(g.locations).find((l) => l.id === a.location || l.name === a.location);
  if (!dest) return reject(m, 'BAD_ARGS', `no such location ${JSON.stringify(a.location)}`, here.connections.map((c) => g.locations[c].name));
  if (!here.connections.includes(dest.id)) return reject(m, 'BAD_ARGS', `${here.name} connects only to ${here.connections.map((c) => g.locations[c].name).join(', ')}`, here.connections);
  (ctx.accepted_detail ||= new Map()).set(m.id, { dest });
  return null;
}
function commitMove(ctx, m) {
  const g = ctx.g;
  const { dest } = ctx.accepted_detail.get(m.id);
  const first = !dest.visited;
  g.party_location = dest.id;
  dest.visited = true;
  ctx.diffs.push(`party.location=${dest.id}`);
  if (first) {
    const id = `as_loc_${dest.id}`;
    ctx.art_jobs.push({ kind: 'environment', subject_id: dest.id, prompt_hint: `${dest.name}, ${dest.description}, anime RPG scene backdrop`, size: [768, 768], steps: 6 });
  }
  return { id: m.id, tool: 'move_to', first_entry: first };
}

function checkAwardXp(ctx, m) {
  const g = ctx.g;
  const a = m.args || {};
  const guidance = get(g, 'rule.xp.curve').data;
  const cap = Math.max(...Object.values(guidance.award_guidance).map((r) => r[1]));
  if (!Number.isInteger(a.amount) || a.amount < 1 || a.amount > cap) return reject(m, 'BAD_ARGS', `amount must be 1-${cap} (largest guidance band)`, [`1..${cap}`]);
  const party = a.party === true;
  if (!party && ![1, 2, 3, 4].includes(a.slot)) return reject(m, 'SLOT_UNKNOWN', 'award_xp needs slot 1-4 or party:true');
  const targets = party ? Object.values(g.characters) : [g.characters[a.slot]];
  if (!targets.every(Boolean)) return reject(m, 'SLOT_UNKNOWN', 'one or more slots have no character');
  const capLevel = get(g, 'rule.xp.curve').data.level_cap;
  if (targets.some((c) => c.level >= capLevel)) return reject(m, 'BAD_ARGS', 'a target is already at the level cap');
  (ctx.accepted_detail ||= new Map()).set(m.id, { targets });
  return null;
}
function commitAwardXp(ctx, m) {
  const g = ctx.g;
  const { targets } = ctx.accepted_detail.get(m.id);
  const curve = get(g, 'rule.xp.curve').data;
  const out = [];
  for (const c of targets) {
    c.xp += m.args.amount;
    let ups = 0;
    while (c.level < curve.level_cap && c.xp >= 100 * c.level) { c.xp -= 100 * c.level; c.level += 1; ups += 1; }
    ctx.diffs.push(`ch_s${c.slot}.xp+${m.args.amount}${ups ? ` level=${c.level}` : ''}`);
    out.push({ slot: c.slot, level: c.level, level_ups: ups });
  }
  return { id: m.id, tool: 'award_xp', result: out };
}

function checkNpc(ctx, m) {
  const g = ctx.g;
  const a = m.args || {};
  const n = validateName(g, a.name, 'npc_name');
  if (!n.ok) return reject(m, 'BAD_ARGS', `npc name rejected: ${n.reason}`, n.allowed);
  if (Object.values(g.npcs).some((x) => x.name.toLowerCase() === n.name.toLowerCase())) return reject(m, 'REJECT_DUPLICATE', `${n.name} is already here`);
  (ctx.accepted_detail ||= new Map()).set(m.id, { name: n.name });
  return null;
}
function commitNpc(ctx, m) {
  const g = ctx.g;
  const d = ctx.accepted_detail.get(m.id);
  const id = `npc_${slug(d.name)}_${++g.seq}`;
  g.npcs[id] = { id, name: d.name, role: String(m.args?.role || ''), portrait_asset_id: null, introduced_turn: g.round };
  ctx.diffs.push(`npc:${id}=+1`);
  if (m.args?.portrait !== false) {
    ctx.art_jobs.push({ kind: 'character', subject_id: id, prompt_hint: `${d.name}, ${m.args?.role || 'npc'}, anime RPG character portrait`, size: [640, 640], steps: 6 });
  }
  return { id, tool: 'introduce_npc' };
}

function commitAll(ctx) {
  const out = [];
  for (const m of ctx.accepted) {
    switch (m.tool) {
      case 'craft_item': out.push(commitCraft(ctx, m)); break;
      case 'take_item': out.push(commitTake(ctx, m)); break;
      case 'drop_item': out.push(commitDrop(ctx, m)); break;
      case 'transfer_item': out.push(commitTransfer(ctx, m)); break;
      case 'move_to': out.push(commitMove(ctx, m)); break;
      case 'award_xp': out.push(commitAwardXp(ctx, m)); break;
      case 'introduce_npc': out.push(commitNpc(ctx, m)); break;
    }
  }
  return out;
}

// --- the budget function (the engine computes stats; the DM only flavours them) ---

/** Largest-remainder apportionment, ties to primary then material lean, then the per-tier cap. */
export function computeItemStats(g, type, tier, mats) {
  const b = get(g, 'rule.budget').data;
  const points = b.stat_points[String(tier)];
  const cap = b.max_single_attribute[String(tier)];
  const lean = dominantLean(g, mats);
  const raw = new Map();
  const bump = (k, v) => raw.set(k, (raw.get(k) || 0) + v);
  bump(type.primary, points * 0.6);
  bump(type.secondary, points * 0.3);
  bump(lean, points * 0.1);

  const stats = {};
  const fr = [];
  let used = 0;
  for (const [k, v] of raw) { stats[k] = Math.floor(v); used += stats[k]; fr.push({ k, f: v - Math.floor(v) }); }
  const rank = { [type.primary]: 0, [lean]: 1, [type.secondary]: 2 };
  fr.sort((a, c) => c.f - a.f || (rank[a.k] ?? 9) - (rank[c.k] ?? 9));
  let rem = points - used, i = 0;
  while (rem > 0 && fr.length) { stats[fr[i % fr.length].k] += 1; rem -= 1; i += 1; }

  // Cap, then roll the excess into the lowest attributes so paying for a legendary cannot evaporate.
  const keys = Object.keys(stats);
  for (const k of keys) {
    let over = stats[k] - cap;
    if (over <= 0) continue;
    stats[k] = cap;
    const others = keys.filter((x) => x !== k).sort((a, c) => stats[a] - stats[c]);
    let j = 0;
    while (over > 0 && others.length && j < 64) {
      const t = others[j % others.length];
      if (stats[t] < cap) { stats[t] += 1; over -= 1; }
      j += 1;
    }
  }

  const carve = type.carve ? stats[type.primary] + Math.floor(tier / 2) + 1 : 0;
  const props = pickProperties(g, tier, mats);
  return { stats, carve, properties: props, points, cap, lean };
}

function dominantLean(g, mats) {
  const w = {};
  for (const mm of mats) {
    const m = tierOf(g, mm.name);
    w[m.lean] = (w[m.lean] || 0) + mm.qty;
  }
  const best = Object.entries(w).sort((a, c) => c[1] - a[1] || (a[0] < c[0] ? -1 : 1))[0];
  return best ? best[0] : 'might';
}

function pickProperties(g, tier, mats) {
  const b = get(g, 'rule.budget').data;
  const table = get(g, 'rule.properties').data.properties;
  const n = b.properties_allowed[String(tier)] ?? 0;
  if (!n) return [];
  const leans = new Set(mats.map((mm) => tierOf(g, mm.name).lean));
  return table.filter((p) => p.min_tier <= tier && leans.has(p.requires_tag)).slice(0, n).map((p) => p.name);
}

// --- naming ----------------------------------------------------------------

export function validateName(g, name, kind = 'item_name') {
  const spec = get(g, 'rule.naming').data[kind];
  const raw = typeof name === 'string' ? name.trim() : '';
  const allowed = [`min ${spec.min_chars}`, `max ${spec.max_chars}`, `max ${spec.max_words} words`];
  if (raw.length < spec.min_chars) return { ok: false, reason: `too short (min ${spec.min_chars})`, allowed };
  if (raw.length > spec.max_chars) return { ok: false, reason: `too long (${raw.length} > ${spec.max_chars})`, allowed };
  if (raw.split(/\s+/).length > spec.max_words) return { ok: false, reason: `too many words (max ${spec.max_words})`, allowed };
  if (spec.disallow && spec.disallow.some((c) => raw.includes(c))) return { ok: false, reason: 'contains a disallowed character', allowed };
  // Control characters break the fence for every kind of name, whether or not a charset is declared:
  // names ride in the prompt inside <name>...</name> on a line-oriented template, so a \n in a proper
  // noun is the end of the fence and the start of the noun's sentences. narration sanitises its
  // newlines for exactly this reason and names did not.
  /* eslint-disable no-control-regex */
  if (/[\u0000-\u001f\u007f]/.test(name || '')) return { ok: false, reason: 'names contain no newlines or control characters', allowed };
  /* eslint-enable no-control-regex */
  // rule.naming spells the item charset out in words and this function was not reading it, so
  // "Blade! @%" and "Blade/with/slashes" were legal item names while character names were fenced. A
  // charset nobody parses is decoration, and names are the one thing every table writes: they land in
  // asset ids, manifest keys, the CARDS pile and the prompt.
  const re = charsetRe(spec);
  if (re) {
    const offender = raw.match(re);
    if (offender) return { ok: false, reason: `uses ${JSON.stringify(offender[0])}, outside the allowed set (${spec.charset})`, allowed };
  }  const low = raw.toLowerCase();
  const reserved = get(g, 'rule.naming').data.reserved_substrings;
  const hit = reserved.find((r) => low.includes(r));
  if (hit) return { ok: false, reason: `reserved word ${JSON.stringify(hit)}: names are data, not instructions`, allowed };
  return { ok: true, name: raw };
}

// The rules describe a charset in words rather than a regex, so the words are the interface. A token
// the engine does not implement is an error, not a free pass: silently permitting an unknown token is
// how a charset rule quietly becomes the kind of rule that only applies to what somebody tried.
const CHARSET_TOKENS = { letters: '\\p{L}', digits: '\\p{N}', space: ' ', hyphen: '\\-', apostrophe: "'", period: '\\.' };
function charsetRe(spec) {
  if (!spec.charset) return null;
  const tokens = String(spec.charset).split(/\s+/).filter(Boolean);
  const unknown = tokens.filter((t) => !(t in CHARSET_TOKENS));
  if (unknown.length) throw new Error(`rule.naming charset names tokens the engine does not implement: ${unknown.join(', ')}`);
  // The regex finds a character that is NOT in the allowed set, so it answers the question the rule
  // actually asks - "does this name use a character outside the set?" - and names the offender, without
  // anchoring anything.
  // Concatenation, and each token escaped for a character class: with the `u` flag a bare `-` mid-class
  // is a syntax error, `.` inside a class is literal, and the rules list their tokens in their own order
  // so nothing here can assume which ones arrive. (The first version of this line was a template literal
  // and failed to parse; it blamed the parser in a comment, and the parser was innocent - the escaping of
  // \p{L} was wrong. That is the whole reason the comment is gone: a wrong explanation in a file that
  // fences names is worse than no explanation.)
  const body = tokens.map((t) => CHARSET_TOKENS[t]).join('');
  return new RegExp('[^' + body + ']', 'u');
}

function findHeld(g, ch, name) {
  return Object.keys(ch.inventory).find((id) => g.items[id].name.toLowerCase() === String(name).toLowerCase() && ch.inventory[id] > 0);
}
function heldNames(g, ch) {
  return Object.keys(ch.inventory).map((id) => g.items[id].name);
}
function knownMaterialNames(g) {
  return get(g, 'rule.materials').data.materials.map((m) => `${m.name}:${m.tier}`);
}
function recipeHint(g, type_name) {
  const types = get(g, 'rule.item.types').data.types;
  const t = types.find((x) => x.name === type_name) || types[0];
  return Object.entries(t.cost).map(([slot, qty]) => `${slot}:${qty}`).concat([`type:${types.map((x) => x.name).join(',')}`]);
}
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 14) || 'thing';
}

// --- persistence -----------------------------------------------------------

function appendEvent(g, ev) {
  if (!process.env.DB_PERSIST) return;
  mkdirSync('saves', { recursive: true });
  appendFileSync(g.events_path, JSON.stringify({ ...ev, at: new Date().toISOString() }) + '\n');
}

export function saveGame(g) {
  const snap = {
    campaign: g.campaign, round: g.round, order_seed: g.order_seed, seq: g.seq, party_location: g.party_location,
    characters: g.characters, items: g.items, npcs: g.npcs, locations: g.locations, log: g.log,
  };
  if (process.env.DB_PERSIST) {
    mkdirSync('saves', { recursive: true });
    writeFileSync(`saves/${g.campaign}.state.json`, JSON.stringify(snap, null, 1));
  }
  return snap;
}

export function loadGame(rules, campaign = 'campaign-1') {
  const p = `saves/${campaign}.state.json`;
  if (!existsSync(p)) return null;
  const snap = JSON.parse(readFileSync(p, 'utf8'));
  const g = newGame(rules, { campaign });
  Object.assign(g, snap, { rules, intents: [], confirms: new Set(), events_path: `saves/${campaign}.events.jsonl` });
  return g;
}
