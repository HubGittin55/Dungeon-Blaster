// Turn test suite: the retry loop, the prefix law, and the bark. No LLM, no GPU, no network - the DM is
// scripted, so this runs anywhere and fails on the same things a real model would fail on.
//
//   node test/turn_test.mjs
//
// What this proves that gate_test.js cannot: that the host running the turn (game/gm.mjs, shared by the
// pi extension and the browser game server) asks twice, appends its corrections as new turns instead of
// editing the cached prefix, and never releases a sentence for a round the gate did not accept whole.

import assert from 'node:assert/strict';
import { loadRules } from '../tracker/rules_doc.js';
import { newGame, joinSlot, addMaterials, setIntents, resolveRound } from '../tracker/engine.js';
import { runTurn, barkFor, RULES_PATH, STARTING_KIT } from '../game/gm.mjs';

const rules = loadRules(RULES_PATH);
let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (e) { fail += 1; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

function table(intents) {
  const g = newGame(rules, { campaign: 'turn-test' });
  for (const s of [1, 2, 3, 4]) {
    joinSlot(g, s, { name: `P${s}`, class_label: 'test' });
    addMaterials(g, s, { ...STARTING_KIT, wood: 6, sinew: 4 }, 'kit');
  }
  setIntents(g, intents || [{ slot: 1, id: 'i1', text: 'lash a wood shaft to a knot of sinew' }], { order_seed: 'deadbeefdeadbeef' });
  return g;
}

const club = (id = 'm1', actor = 1, intent = 'i1') => ({
  id, tool: 'craft_item', actor, intent,
  args: { name: 'Oaken club', item_type: 'weapon', materials: [{ name: 'wood', qty: 2 }, { name: 'sinew', qty: 1 }] },
});

/** Pays for something the rules never heard of: deterministic MATERIAL_UNKNOWN, no model required. */
const moonglass = (id = 'm1', actor = 1, intent = 'i1') => ({
  id, tool: 'craft_item', actor, intent,
  args: { name: 'Moonglass reaver', item_type: 'weapon', materials: [{ name: 'moonglass', qty: 3 }] },
});

/** A DM that answers from a script and remembers exactly what it was asked each time. */
function scripted(...answers) {
  const seen = [];
  const complete = async (messages) => {
    const a = answers[seen.length] ?? answers[answers.length - 1];
    seen.push(messages.map((m) => ({ ...m })));
    return typeof a === 'function' ? a(messages) : a;
  };
  return { complete, seen };
}

const said = (text, mutations) => ({ narration: text, mutations });

await t('a legal contract is accepted on the first attempt and its narration is released', async () => {
  const g = table();
  const { complete, seen } = scripted(said('You lash wood to sinew and it holds.', [club()]));
  const { result, attempts } = await runTurn(g, { complete });
  assert.equal(attempts.length, 1, `took ${attempts.length} attempts`);
  assert.ok(result.ok, `rejected: ${JSON.stringify(result.rejected)}`);
  assert.equal(result.committed.length, 1);
  assert.equal(result.turn_log.narration, 'You lash wood to sinew and it holds.');
  assert.equal(barkFor(result.turn_log), null, 'a committed round should not need a bark');
  assert.equal(seen.length, 1);
});

await t('a rejected round retries once with the gate feedback appended as a NEW turn', async () => {
  const g = table();
  const bad = said('Bram forges moonglass out of nothing.', [moonglass()]);
  const good = said('You knot your own shaft and it holds.', [club()]);
  const { complete, seen } = scripted(bad, good);
  const { result, attempts } = await runTurn(g, { complete });
  assert.equal(attempts.length, 2, 'expected a retry');
  assert.ok(result.ok, `second attempt should pass: ${JSON.stringify(result.rejected)}`);
  const [a, b] = attempts.map((x) => x.messages);
  assert.ok(b.length > a.length, 'the correction must arrive as extra turns');
  assert.equal(JSON.stringify(b.slice(0, a.length)), JSON.stringify(a), 'the cached prefix must not be rewritten');
  assert.match(b[b.length - 1].content, /tracker rejected this round/);
  assert.match(b[b.length - 1].content, /MATERIAL_UNKNOWN/, 'feedback must carry the code and the allowed values');
  assert.match(b[b.length - 1].content, /allowed:/, 'and the allowed values, not just the complaint');
});

await t('a prompt prefix that varies between retries is a 151 second re-eval, so it is a test failure', async () => {
  const g = table();
  const { complete } = scripted(said('nope', [moonglass()]), said('fine', [club()]));
  const { attempts } = await runTurn(g, { complete });
  const [a, b] = attempts.map((x) => x.messages);
  // system = persona only, rules second, mutable state third - byte-identical across the retry.
  assert.equal(a[0].content, b[0].content, 'persona changed between attempts');
  assert.equal(a[1].content, b[1].content, 'rules block changed between attempts');
  assert.equal(a[2].content, b[2].content, 'mutable tail changed inside the round');
  assert.equal(attempts.length, 2);
});

await t('two bad attempts fall back: the valid subset commits, the sentence is withheld, a bark is available', async () => {
  const g = table();
  const half = () => ({
    narration: 'Bram conjures a moonglass reaver and hands it to everyone at once.',
    mutations: [club('m1', 1, 'i1'), moonglass('m2', 1, 'i1')], // m2 pays with a material that does not exist
  });
  const { result } = await runTurn(g, { complete: scripted(half).complete });
  assert.equal(result.ok, false, 'a round with a rejected mutation is not ok');
  assert.equal(result.turn_log.mode, 'fallback');
  assert.ok(result.turn_log.narration == null, 'a fallback round must not release its sentence');
  assert.ok(result.turn_log.narration_blocked, 'the block reason must be recorded, not swallowed');
  assert.ok(result.committed.some((c) => c.tool === 'craft_item'), 'the affordable half should still commit');
  assert.ok(result.narration_dropped.includes('MATERIAL_UNKNOWN'), result.narration_dropped);
  assert.ok(barkFor(result.turn_log), 'the players still need to hear something');
});

await t('the second attempt is the last chance: a third bad answer is never asked for', async () => {
  const g = table();
  const bad = () => said('still wrong', [moonglass()]);
  const { complete, seen } = scripted(bad, bad, bad);
  const { result } = await runTurn(g, { complete });
  assert.equal(seen.length, 2, `asked ${seen.length} times`);
  assert.ok(result);
});

await t('a bark never contains a claim: atmosphere only, because nothing was verified', async () => {
  const nothing = barkFor({ mode: 'strict' });
  const partial = barkFor({ mode: 'fallback' });
  assert.ok(nothing && partial);
  for (const line of [nothing, partial]) {
    assert.doesNotMatch(line, /\d/, `a bark that counts is a bark that can be wrong: ${line}`);
    assert.doesNotMatch(line, /(Bram|Ash|Sable|Piper|iron|steel|\+1|damage)/i, `bark names a verifiable fact: ${line}`);
  }
});

// The guard Stunkus asked for by name: "the early-out has unit coverage via mutationHash but no turn-level
// test, so a refactor can drop it again without a test going red." He was right, and the refactor that
// dropped it was mine. These two tests are the difference between a law and a comment.

await t('a retry that repeats the first attempt is stopped BEFORE the gate runs again', async () => {
  const g = table();
  let gates = 0;
  const gate = (gg, call, opt) => { gates++; return resolveRound(gg, call, opt); };
  // A stubborn DM: the same MATERIAL_UNKNOWN proposal however many times it is told the answer.
  const { complete, seen } = scripted(said('Moonglass. It is moonglass and I will not be reasoned with.', [moonglass()]));
  const { result } = await runTurn(g, { complete, gate });
  assert.equal(seen.length, 2, `model was asked ${seen.length} times`);
  // Without the early-out this is 2: the repeat gets gated a second time and the round pays a gate for a
  // proposal that is byte-identical to the one it just rejected.
  assert.equal(gates, 1, `gate ran ${gates} times - the identical retry was gated again`);
  assert.equal(result.ok, false);
  assert.equal(result.rejected[0].code, 'MATERIAL_UNKNOWN');
});

await t('but a retry that LEARNED something still gets gated (the early-out must not swallow it)', async () => {
  const g = table();
  let gates = 0;
  const gate = (gg, call, opt) => { gates++; return resolveRound(gg, call, opt); };
  const { complete } = scripted(
    said('Moonglass.', [moonglass('m1')]),
    said('Fine. Wood and sinew.', [club('m1')]));
  const { result } = await runTurn(g, { complete, gate });
  assert.equal(gates, 2, `gate ran ${gates} times; a changed retry must still be evaluated`);
  assert.ok(result.ok, `the corrected retry should commit: ${JSON.stringify(result.rejected)}`);
  assert.equal(result.committed.length, 1);
});

await t('four players speaking in one round are all resolved by that round', async () => {
  // Blarmo's complaint about the demo: one shared GM turn read like "it picked one action and ignored the
  // rest". The engine was never the problem - it has always accepted mutations from every seat in a single
  // round - but nothing in the suite proved it, so nothing stopped a host from being written to read only
  // the first intent. This is the assertion that makes that a test failure instead of a playtest surprise.
  const g = table([
    { slot: 1, id: 'i1', text: 'kick in the door' },
    { slot: 2, id: 'i2', text: 'listen along the wall' },
    { slot: 3, id: 'i3', text: 'lash a wood shaft to a knot of sinew' },
    { slot: 4, id: 'i4', text: 'pray to whoever owns this cellar' },
  ]);
  const { complete } = scripted(said('Four people do four things at once.', [
    club('m1', 1, 'i1'), club('m2', 2, 'i2'), club('m3', 3, 'i3'), club('m4', 4, 'i4'),
  ]));
  const { result } = await runTurn(g, { complete });
  assert.equal(result.ok, true, JSON.stringify(result.rejected));
  assert.equal(result.committed.length, 4, 'a single round must be able to pay for all four seats');
  assert.equal(Object.keys(g.items).length, 4, `four clubs should exist, saw ${Object.keys(g.items).length}`);
});

await t('a round with nothing to pay for still commits', async () => {
  // The scripted DM now says "the room does not change" for intents it cannot act on, which means it ships
  // narration with no mutations at all. If an empty round were rejected, an honest answer would look like a
  // rules violation and the table would get a stock bark instead of the truth.
  const g = table([{ slot: 1, id: 'i1', text: 'listen along the wall' }]);
  const { complete } = scripted(said('You listen along the wall. The room does not change.', []));
  const { result } = await runTurn(g, { complete });
  assert.equal(result.ok, true, JSON.stringify(result.rejected));
  assert.equal(result.committed.length, 0);
  assert.match(result.turn_log.narration, /does not change/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

