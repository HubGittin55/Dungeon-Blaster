// Within-round double-spend: two crafts in ONE round, each legal alone, overdrawing together.
import { newGame, setIntents, resolveRound, takeSeat, addMaterials } from './tracker/engine.js';
import { loadRules } from './tracker/rules_doc.js';

const rules = loadRules('rules/rules.md');
function seatAll(g) {
  const sheets = [
    { slot: 1, name: 'Bram', cls: 'Brute', attributes: { might: 3, agility: 2, grit: 2, focus: 2, awe: 1 } },
    { slot: 2, name: 'Ash', cls: 'Cutter', attributes: { might: 2, agility: 3, grit: 2, focus: 2, awe: 1 } },
  ];
  for (const s of sheets) takeSeat(g, s.slot, { name: s.name, cls: s.cls, attributes: s.attributes });
}

// --- W1. two crafts, same actor, same round, different names, 3 wood total, each needs 2 ---
{
  const g = newGame(rules);
  seatAll(g);
  addMaterials(g, 1, { wood: 3, sinew: 2 });
  setIntents(g, [{ id: 'i1', slot: 1, text: 'craft two clubs' }, { id: 'i2', slot: 2, text: 'watch' }]);
  const r = resolveRound(g, { narration: 'Bram makes two clubs.', mutations: [
    { id: 'm1', tool: 'craft_item', actor: 1, intent: 'i1', args: { name: 'Club Alpha', item_type: 'weapon', materials: [{ name: 'wood', qty: 2 }, { name: 'sinew', qty: 1 }] } },
    { id: 'm2', tool: 'craft_item', actor: 1, intent: 'i1', args: { name: 'Club Beta', item_type: 'weapon', materials: [{ name: 'wood', qty: 2 }, { name: 'sinew', qty: 1 }] } },
  ] }, { mode: 'strict' });
  console.log('W1 two crafts one round: ok =', r.ok, '| wood now =', g.characters[1].materials.wood, '| sinew now =', g.characters[1].materials.sinew,
    '| items =', Object.values(g.items).map((i) => i.name).join(', '), '| rejected =', JSON.stringify(r.rejected?.map((x) => x.code)));
}

// --- W2. two crafts, different actors, same material pool? (materials are per-slot, so no) ---
// Instead: two takes of the SAME loot in one round (claims map should save this) - control case.
{
  const g = newGame(rules);
  seatAll(g);
  setIntents(g, [{ id: 'i1', slot: 1, text: 'go' }]);
  resolveRound(g, { narration: 'go', mutations: [{ id: 'm0', tool: 'move_to', actor: null, intent: null, args: { location: 'corridor' } }] }, { mode: 'strict' });
  setIntents(g, [{ id: 'i1', slot: 1, text: 'take' }, { id: 'i2', slot: 2, text: 'take' }]);
  const r = resolveRound(g, { narration: 'both grab iron.', mutations: [
    { id: 'm1', tool: 'take_item', actor: 1, intent: 'i1', args: { name: 'iron', qty: 2 } },
    { id: 'm2', tool: 'take_item', actor: 2, intent: 'i2', args: { name: 'iron', qty: 2 } },
  ] }, { mode: 'strict' });
  console.log('W2 two takes one round (control): ok =', r.ok, '| iron left =', g.locations.corridor.loot.find((l) => l.name === 'iron')?.qty,
    '| slot1 iron =', g.characters[1].materials.iron, '| slot2 iron =', g.characters[2].materials.iron,
    '| rejected =', JSON.stringify(r.rejected?.map((x) => x.id + ':' + x.code)));
}

// --- W3. two transfers of the SAME unique item in one round (crash?) ---
{
  const g = newGame(rules);
  seatAll(g);
  addMaterials(g, 1, { wood: 2, sinew: 1 });
  setIntents(g, [{ id: 'i1', slot: 1, text: 'craft' }]);
  let r = resolveRound(g, { narration: 'craft', mutations: [
    { id: 'm1', tool: 'craft_item', actor: 1, intent: 'i1', args: { name: 'Knotwood club', item_type: 'weapon', materials: [{ name: 'wood', qty: 2 }, { name: 'sinew', qty: 1 }] } },
  ] }, { mode: 'strict' });
  g.confirms.add('1:2');
  setIntents(g, [{ id: 'i1', slot: 1, text: 'give' }, { id: 'i2', slot: 2, text: 'take' }]);
  try {
    r = resolveRound(g, { narration: 'pass it twice.', mutations: [
      { id: 'm2', tool: 'transfer_item', actor: 1, intent: 'i1', args: { name: 'Knotwood club', to_slot: 2, qty: 1 } },
      { id: 'm3', tool: 'transfer_item', actor: 1, intent: 'i1', args: { name: 'Knotwood club', to_slot: 2, qty: 1 } },
    ] }, { mode: 'strict' });
    console.log('W3 two transfers one round: ok =', r.ok, '| slot1 inv =', JSON.stringify(g.characters[1].inventory),
      '| slot2 inv =', JSON.stringify(g.characters[2].inventory), '| item owner =', Object.values(g.items)[0]?.owner,
      '| rejected =', JSON.stringify(r.rejected?.map((x) => x.id + ':' + x.code)));
  } catch (e) {
    console.log('W3 two transfers one round: THREW:', e.message);
  }
}

// --- W4. two drops of the same unique item in one round ---
{
  const g = newGame(rules);
  seatAll(g);
  addMaterials(g, 1, { wood: 2, sinew: 1 });
  setIntents(g, [{ id: 'i1', slot: 1, text: 'craft' }]);
  resolveRound(g, { narration: 'craft', mutations: [
    { id: 'm1', tool: 'craft_item', actor: 1, intent: 'i1', args: { name: 'Knotwood club', item_type: 'weapon', materials: [{ name: 'wood', qty: 2 }, { name: 'sinew', qty: 1 }] } },
  ] }, { mode: 'strict' });
  setIntents(g, [{ id: 'i1', slot: 1, text: 'drop' }]);
  try {
    const r = resolveRound(g, { narration: 'drop it twice.', mutations: [
      { id: 'm2', tool: 'drop_item', actor: 1, intent: 'i1', args: { name: 'Knotwood club', qty: 1 } },
      { id: 'm3', tool: 'drop_item', actor: 1, intent: 'i1', args: { name: 'Knotwood club', qty: 1 } },
    ] }, { mode: 'strict' });
    console.log('W4 two drops one round: ok =', r.ok, '| slot1 inv =', JSON.stringify(g.characters[1].inventory),
      '| item owner =', Object.values(g.items)[0]?.owner, '| rejected =', JSON.stringify(r.rejected?.map((x) => x.id + ':' + x.code)));
  } catch (e) {
    console.log('W4 two drops one round: THREW:', e.message);
  }
}

// --- W5. craft + take in one round competing for the same material? (craft spends wood, take gains iron - no conflict) ---
// Instead: award_xp to a slot at cap + another slot (party award rejected wholesale if one is capped)
{
  const g = newGame(rules);
  seatAll(g);
  g.characters[1].level = 20; // at cap
  setIntents(g, [{ id: 'i1', slot: 1, text: 'xp' }]);
  const r = resolveRound(g, { narration: 'everyone gains.', mutations: [
    { id: 'm1', tool: 'award_xp', actor: null, intent: null, args: { party: true, amount: 50 } },
  ] }, { mode: 'strict' });
  console.log('W5 party XP with one capped: ok =', r.ok, '| rejected =', JSON.stringify(r.rejected?.map((x) => x.code)),
    '| slot2 xp =', g.characters[2].xp);
}
