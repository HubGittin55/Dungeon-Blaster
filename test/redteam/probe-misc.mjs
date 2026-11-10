// Two quick confirmations: (a) checkTransfer burns the confirm on a rejected round;
// (b) a corrupt manifest degrades gracefully.
import { newGame, setIntents, resolveRound, takeSeat, addMaterials } from '../../tracker/engine.js';
import { loadRules } from '../../tracker/rules_doc.js';
import { loadArt } from '../../game/art.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const rules = loadRules('rules/rules.md');
function seatAll(g) {
  takeSeat(g, 1, { name: 'Bram', cls: 'Brute', attributes: { might: 3, agility: 2, grit: 2, focus: 2, awe: 1 } });
  takeSeat(g, 2, { name: 'Ash', cls: 'Cutter', attributes: { might: 2, agility: 3, grit: 2, focus: 2, awe: 1 } });
}

// (a) confirm burn: confirm exists, round has a valid transfer + an invalid craft -> strict rejects all.
// Does the confirm survive for the retry?
{
  const g = newGame(rules);
  seatAll(g);
  addMaterials(g, 1, { wood: 2, sinew: 1 });
  setIntents(g, [{ id: 'i1', slot: 1, text: 'craft' }]);
  resolveRound(g, { narration: 'craft', mutations: [
    { id: 'm1', tool: 'craft_item', actor: 1, intent: 'i1', args: { name: 'Knotwood club', item_type: 'weapon', materials: [{ name: 'wood', qty: 2 }, { name: 'sinew', qty: 1 }] } },
  ] }, { mode: 'strict' });
  g.confirms.add('1:2');
  setIntents(g, [{ id: 'i1', slot: 1, text: 'give' }, { id: 'i2', slot: 2, text: 'take' }]);
  const r = resolveRound(g, { narration: 'give and break.', mutations: [
    { id: 'm2', tool: 'transfer_item', actor: 1, intent: 'i1', args: { name: 'Knotwood club', to_slot: 2, qty: 1 } },
    { id: 'm3', tool: 'craft_item', actor: 1, intent: 'i1', args: { name: 'Impossible', item_type: 'weapon', materials: [{ name: 'moonglass', qty: 1 }] } },
  ] }, { mode: 'strict' });
  console.log('(a) rejected round with a valid transfer in it: ok =', r.ok,
    '| confirm still present =', g.confirms.has('1:2'),
    '| item still with slot 1 =', Object.keys(g.characters[1].inventory).length === 1);
}

// (b) corrupt manifest
{
  const dir = '/tmp/db-arttest';
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/manifest.json`, '{"schema":1,"style":"x","assets":[{"id":"a","file":"x/a.png"},');
  const art = loadArt(dir, 'x', { log: () => {} });
  const res = art.resolve({ kind: 'material', subject_id: 'wood' }, { style: 'x' });
  console.log('(b) corrupt manifest: resolve ->', res, '| status =', JSON.stringify(art.status));
  // manifest pointing outside the tree
  writeFileSync(`${dir}/manifest.json`, JSON.stringify({ schema: 1, style: 'x', assets: [{ id: 'evil', file: '../../etc/passwd' }, { id: 'gone', file: 'x/nope.png' }] }));
  const art2 = loadArt(dir, 'x', { log: (m) => console.log('   [art]', m) });
  console.log('(b) escape record: resolve evil ->', art2.resolve({ kind: 'material', subject_id: 'evil' }, { style: 'x' }));
  console.log('(b) missing file record: resolve gone ->', art2.resolve({ kind: 'material', subject_id: 'gone' }, { style: 'x' }));
}
