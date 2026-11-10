// Red-team probes against tracker/engine.js (d73ba44). Read-only: no pushes, no server needed.
import { newGame, setIntents, resolveRound, takeSeat, addMaterials, validateName } from '../../tracker/engine.js';
import { loadRules } from '../../tracker/rules_doc.js';

const rules = loadRules('rules/rules.md');
const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
}

function seatAll(g) {
  const sheets = [
    { slot: 1, name: 'Bram', cls: 'Brute', attributes: { might: 3, agility: 2, grit: 2, focus: 2, awe: 1 } },
    { slot: 2, name: 'Ash', cls: 'Cutter', attributes: { might: 2, agility: 3, grit: 2, focus: 2, awe: 1 } },
    { slot: 3, name: 'Sable', cls: 'Charmer', attributes: { might: 1, agility: 2, grit: 2, focus: 3, awe: 2 } },
    { slot: 4, name: 'Piper', cls: 'Brute', attributes: { might: 3, agility: 2, grit: 2, focus: 1, awe: 2 } },
  ];
  for (const s of sheets) {
    const r = takeSeat(g, s.slot, { name: s.name, cls: s.cls, attributes: s.attributes });
    if (!r.ok) throw new Error(`seat ${s.slot} failed: ${JSON.stringify(r.rejected)}`);
  }
}
function round(g, intents, mutations) {
  setIntents(g, intents);
  return resolveRound(g, { narration: 'test', mutations }, { mode: 'strict' });
}

// --- 1. transfer_item: qty > held for a unique item (duplication?) ---
{
  const g = newGame(rules);
  seatAll(g);
  addMaterials(g, 1, { wood: 2, sinew: 1 });
  let r = round(g,
    [{ id: 'i1', slot: 1, text: 'craft' }],
    [{ id: 'm1', tool: 'craft_item', actor: 1, intent: 'i1', args: { name: 'Knotwood club', item_type: 'weapon', materials: [{ name: 'wood', qty: 2 }, { name: 'sinew', qty: 1 }] } }]);
  const itemId = r.committed[0]?.item?.id;
  const heldBefore = g.characters[1].inventory[itemId];
  // now transfer qty 5 of an item held exactly once
  r = round(g,
    [{ id: 'i1', slot: 1, text: 'give it' }, { id: 'i2', slot: 2, text: 'take it' }],
    [{ id: 'm2', tool: 'transfer_item', actor: 1, intent: 'i1', args: { name: 'Knotwood club', to_slot: 2, qty: 5 } }]);
  // transfer needs the confirm keypress; emulate it
  console.log('  (transfer without confirm ->', JSON.stringify(r.rejected?.[0]?.code), ')');
  g.confirms.add('1:2');
  r = round(g,
    [{ id: 'i1', slot: 1, text: 'give it' }, { id: 'i2', slot: 2, text: 'take it' }],
    [{ id: 'm2', tool: 'transfer_item', actor: 1, intent: 'i1', args: { name: 'Knotwood club', to_slot: 2, qty: 5 } }]);
  const giverQty = g.characters[1].inventory[itemId] ?? 0;
  const recvQty = g.characters[2].inventory[itemId] ?? 0;
  check('transfer qty>held rejected', r.ok === false, `held=${heldBefore}, giver now=${giverQty}, receiver now=${recvQty}, ok=${r.ok}, rejected=${JSON.stringify(r.rejected?.map(x => x.code))}`);
}

// --- 2. take_item with negative qty (loot duplication?) ---
{
  const g = newGame(rules);
  seatAll(g);
  // party is at 'start'; corridor has iron x2. Move there first.
  let r = round(g, [{ id: 'i1', slot: 1, text: 'go' }],
    [{ id: 'm1', tool: 'move_to', actor: null, intent: null, args: { location: 'corridor' } }]);
  const before = g.locations.corridor.loot.find((l) => l.name === 'iron')?.qty;
  const matsBefore = g.characters[1].materials.iron || 0;
  r = round(g, [{ id: 'i1', slot: 1, text: 'take' }],
    [{ id: 'm2', tool: 'take_item', actor: 1, intent: 'i1', args: { name: 'iron', qty: -1 } }]);
  const after = g.locations.corridor.loot.find((l) => l.name === 'iron')?.qty;
  const matsAfter = g.characters[1].materials.iron || 0;
  check('take_item qty=-1 rejected', r.ok === false, `room iron ${before} -> ${after}, player iron ${matsBefore} -> ${matsAfter}, ok=${r.ok}`);
}

// --- 3. take_item with qty=0 (no-op that claims the loot / blocks contention) ---
{
  const g = newGame(rules);
  seatAll(g);
  round(g, [{ id: 'i1', slot: 1, text: 'go' }],
    [{ id: 'm1', tool: 'move_to', actor: null, intent: null, args: { location: 'corridor' } }]);
  const r = round(g,
    [{ id: 'i1', slot: 1, text: 'take' }, { id: 'i2', slot: 2, text: 'take too' }],
    [
      { id: 'm2', tool: 'take_item', actor: 1, intent: 'i1', args: { name: 'iron', qty: 0 } },
      { id: 'm3', tool: 'take_item', actor: 2, intent: 'i2', args: { name: 'iron', qty: 2 } },
    ]);
  const ironLeft = g.locations.corridor.loot.find((l) => l.name === 'iron')?.qty;
  check('take_item qty=0 rejected (or at least does not block a real take)',
    r.rejected?.some((x) => x.id === 'm2') || r.committed?.some((c) => c.id === 'm3'),
    `iron left=${ironLeft}, rejected=${JSON.stringify(r.rejected?.map(x => x.id + ':' + x.code))}`);
}

// --- 4. drop_item with qty > held for a unique item (silent destruction?) ---
{
  const g = newGame(rules);
  seatAll(g);
  addMaterials(g, 1, { wood: 2, sinew: 1 });
  let r = round(g, [{ id: 'i1', slot: 1, text: 'craft' }],
    [{ id: 'm1', tool: 'craft_item', actor: 1, intent: 'i1', args: { name: 'Knotwood club', item_type: 'weapon', materials: [{ name: 'wood', qty: 2 }, { name: 'sinew', qty: 1 }] } }]);
  const itemId = r.committed[0]?.item?.id;
  r = round(g, [{ id: 'i1', slot: 1, text: 'drop' }],
    [{ id: 'm2', tool: 'drop_item', actor: 1, intent: 'i1', args: { name: 'Knotwood club', qty: 5 } }]);
  const stillHeld = g.characters[1].inventory[itemId] ?? 0;
  const itemExists = !!g.items[itemId];
  const owner = g.items[itemId]?.owner;
  const inLoot = g.locations[g.party_location].loot.some((l) => l.name === 'Knotwood club');
  check('drop_item qty>held rejected', r.ok === false,
    `held now=${stillHeld}, item exists=${itemExists}, owner=${owner}, in room loot=${inLoot}, ok=${r.ok}`);
}

// --- 5. drop_item with negative qty for a material (create from nothing?) ---
{
  const g = newGame(rules);
  seatAll(g);
  addMaterials(g, 1, { wood: 2, sinew: 1 });
  const before = g.characters[1].materials.wood;
  const r = round(g, [{ id: 'i1', slot: 1, text: 'drop' }],
    [{ id: 'm2', tool: 'drop_item', actor: 1, intent: 'i1', args: { name: 'wood', qty: -1 } }]);
  const after = g.characters[1].materials.wood;
  const roomWood = g.locations[g.party_location].loot.find((l) => l.name === 'wood');
  check('drop_item qty=-1 rejected', r.ok === false,
    `player wood ${before} -> ${after}, room wood entry=${JSON.stringify(roomWood)}, ok=${r.ok}`);
}

// --- 6. transfer_item with negative qty for a material (reversed transfer?) ---
{
  const g = newGame(rules);
  seatAll(g);
  addMaterials(g, 1, { wood: 3 });
  addMaterials(g, 2, { wood: 1 });
  g.confirms.add('1:2');
  const b1 = g.characters[1].materials.wood, b2 = g.characters[2].materials.wood;
  const r = round(g,
    [{ id: 'i1', slot: 1, text: 'give' }, { id: 'i2', slot: 2, text: 'take' }],
    [{ id: 'm2', tool: 'transfer_item', actor: 1, intent: 'i1', args: { name: 'wood', to_slot: 2, qty: -1 } }]);
  const a1 = g.characters[1].materials.wood, a2 = g.characters[2].materials.wood;
  check('transfer_item qty=-1 rejected', r.ok === false,
    `wood slot1 ${b1} -> ${a1}, slot2 ${b2} -> ${a2}, ok=${r.ok}`);
}

// --- 7. naming charset: rules say letters/digits/space/hyphen/apostrophe/period ---
{
  const v = validateName(g0(), 'Blade! @%', 'item_name');
  check('item name with ! @ % rejected (charset)', v.ok === false, `validateName -> ${JSON.stringify(v)}`);
  const v2 = validateName(g0(), 'Blade/with/slashes', 'item_name');
  check('item name with / rejected (charset)', v2.ok === false, `validateName -> ${JSON.stringify(v2)}`);
}
function g0() { return newGame(rules); }

// --- 8. takeSeat with an invalid name throws instead of rejecting ---
{
  const g = newGame(rules);
  let threw = null;
  try {
    takeSeat(g, 1, { name: 'x', cls: 'Brute', attributes: { might: 3, agility: 2, grit: 2, focus: 2, awe: 1 } });
  } catch (e) { threw = e.message; }
  check('takeSeat bad name returns rejection, not throw', threw === null, threw ? `threw: ${threw}` : 'returned normally');
}

console.log('\n--- summary ---');
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}`);
