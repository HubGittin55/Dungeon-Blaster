// HTTP surface test suite: the front door, not the law behind it.
//
//   node test/http_test.mjs
//
// gate_test.js proves what the tracker refuses. This proves what a browser or a curl gets, and that is a
// surface nothing here tested until 2026-11-10, when a hostile battery found that a truncated JSON body
// answered 500 with a JavaScript parse error on six of seven routes - a law the repo states out loud
// ("malformed POST must 400") and had never once checked. Every route used to open its own JSON.parse and
// exactly one bothered to catch, which is how a rule held by six places breaks in six places.
//
// It boots the real server as a child process, in --fake-dm (no model, no GPU), and drives it with fetch.
// Deliberately a real process: a mock server answers a 500 by not crashing, which is the one thing a mock
// cannot tell you.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { slug, assetId } from '../game/art.mjs';

const PORT = Number(process.env.DB_HTTP_TEST_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const GOOD_SHEET = { might: 3, agility: 3, grit: 2, focus: 1, awe: 1 };

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (e) { fail += 1; console.log(`FAIL  ${name}\n      ${e.message}`); }
};

const post = async (path, bodyRaw, headers = {}) => {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof bodyRaw === 'string' ? bodyRaw : JSON.stringify(bodyRaw),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* asserted against below */ }
  return { status: r.status, json, text };
};
const get = async (path) => {
  const r = await fetch(BASE + path);  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { }
  return { status: r.status, json, text };
};

// Poll until a round lands. A turn is asynchronous by design - /api/round answers 202 and the outcome
// arrives on SSE - so a test that wants the settled table has to wait for it rather than sleep a guess.
const until = async (fn, ms = 10_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((s) => setTimeout(s, 100));
  }
};

// ---------------------------------------------------------------- spawn
// Port discipline: an occupied port means this suite would drive whatever else is listening - the dev
// table on 8771 answers exactly the same requests, and a green run would have tested nothing.
const probe = await fetch(`${BASE}/api/state`).then(() => 'busy').catch(() => 'free');
if (probe === 'busy') {
  console.error(`FAIL  port ${PORT} is already answering. Nothing here can tell my server from yours, so this suite refuses to run. Set DB_HTTP_TEST_PORT.`);
  process.exit(1);
}

const child = spawn(process.execPath, ['game/server.mjs', '--fake-dm'], {
  env: { ...process.env, DB_GAME_PORT: String(PORT), DB_PERSIST: '0', DB_TTS_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });

const alive = () => child.exitCode === null && child.signalCode === null;
const die = (what) => {
  console.error(`FAIL  server process died during: ${what} (exit ${child.exitCode})`);
  console.error(output.slice(-1500));
  process.exit(1);
};
child.on('exit', () => { if (running) die('an assertion was in flight'); });
let running = true;

async function waitForServer(ms = 20_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!alive()) die('startup');
    const r = await get('/api/state').catch(() => null);
    if (r && r.status === 200) return;
    await new Promise((s) => setTimeout(s, 200));
  }
  console.error(output.slice(-1500));
  throw new Error(`server did not answer /api/state within ${ms}ms`);
}

try {
  await waitForServer();

  console.log('\n== a body the server cannot read is refused, not survived ==');

  await t('a truncated body answers 400, and never a 500', async () => {
    // The bug this test exists for: `{\"slot\":1,` threw out of the handler and the client got a JavaScript
    // parse error with a 500 on it. A phone locking mid-request used to be able to do that to any route.
    for (const [route, bodyRaw] of [
      ['/api/seat', '{"slot":1,'],
      ['/api/intent', '{"slot":1,"text":"open the door'],
      ['/api/scene', '{"description":"a room'],
      ['/api/portrait', '{"description":'],
      ['/api/art/generate', 'not json at all'],
      ['/api/settings', '[{"style":"shinkai"}'],
    ]) {
      const r = await post(route, bodyRaw);
      assert.equal(r.status, 400, `${route} answered ${r.status} for a broken body: ${r.text.slice(0, 90)}`);
      assert(/must be JSON|JSON object/.test(r.json?.error || ''), `${route} said: ${r.text.slice(0, 90)}`);
    }
    assert(alive(), 'the server died on a malformed body');
  });

  await t('valid JSON of the wrong shape is refused with the shape it wants', async () => {
    // "[{"slot":1}]" is valid JSON, so "body must be JSON" would be a lie. Say what is accepted instead.
    const r = await post('/api/seat', '[{"slot":1}]');
    assert.equal(r.status, 400);
    assert(/object/i.test(r.json.error), r.json.error);
    const n = await post('/api/seat', '"brute"');
    assert.equal(n.status, 400, 'a bare string is not a character sheet');
  });

  await t('a body the size of a save file is refused, not assembled in RAM', async () => {
    // The laptop also holds a 35B model, a TTS model and ComfyUI. A 2 GB POST used to be welcomed.
    const r = await post('/api/scene', JSON.stringify({ description: 'A'.repeat(4 << 20), generate: false }));
    assert.equal(r.status, 413, `got ${r.status}: ${r.text.slice(0, 120)}`);
    assert(/65536|character sheet/.test(r.json.error), r.json.error);
    assert(alive(), 'the server died on an oversized body');
    // The bug this line pins: the first fix answered 413 and destroyed the socket, and the next request on the
    // same keep-alive connection waited five minutes for a response to a body nobody had finished reading.
    const after = await get('/api/state');
    assert.equal(after.status, 200, 'a refusal poisoned the connection: the next request could not be served');
  });

  await t('a body far bigger than a mistake is closed, not drained forever', async () => {
    // 36 MB, deliberately: under the 32 MB flood ceiling it is a mistake and gets a real 413, over it the
    // connection is dropped. Both are correct answers; a hang or a crashed server is not.
    const big = 'A'.repeat(36 << 20);
    let status = 0, died = false;
    try { const r = await post('/api/scene', JSON.stringify({ description: big, generate: false })); status = r.status; }
    catch { died = !alive(); }
    assert(!died, 'the server process died on a 36 MB POST');
    assert(status === 0 || [413, 507].includes(status), `a 36 MB POST answered ${status}`);
    const after = await get('/api/state');
    assert.equal(after.status, 200, 'the server stopped answering after a flood');
  });

  await t('a seat number is a seat number', async () => {
    for (const bad of [99, 0, -1, 'eleven', null, {}, [2]]) {
      const r = await post('/api/seat', { slot: bad, random: true });
      assert.equal(r.status, 400, `slot ${JSON.stringify(bad)} was accepted`);
      assert(/slot must be 1-4/.test(r.json.error), r.json.error);
    }
  });

  console.log('\n== what reaches the couch is the rules\' own wording ==');

  await t('an illegal sheet comes back as the rules refused it, line by line', async () => {
    //awe below min_start and only 9 points spent: two separate complaints, both named, nothing rounded up.
    const r = await post('/api/seat', { slot: 1, name: 'Bram', cls: 'Brute', attributes: { might: 3, agility: 3, grit: 2, focus: 1, awe: 0 } });
    assert.equal(r.status, 400);
    const codes = (r.json.rejected || []).map((x) => x.code).sort();
    assert.deepEqual(codes, ['ATTRIBUTE_RANGE', 'POINTS_MISMATCH'], JSON.stringify(r.json));
    assert(/1-5/.test(JSON.stringify(r.json)), 'the range itself should be in the message');
    assert(/exactly 10/.test(JSON.stringify(r.json)), 'the total it must spend should be in the message');
  });

  await t('an invented class is refused by naming the classes that exist', async () => {
    const r = await post('/api/seat', { slot: 1, name: 'X', cls: 'Warden', attributes: GOOD_SHEET });
    assert.equal(r.status, 400);
    assert.equal(r.json.rejected[0].code, 'UNKNOWN_CLASS');
    for (const cls of ['Brute', 'Cutter', 'Charmer']) assert(r.text.includes(cls), `refusal never named ${cls}`);
  });

  await t('a legal sheet seats, and the state shows the character rather than the fact of one', async () => {
    const r = await post('/api/seat', { slot: 1, name: 'Bram', cls: 'Brute', attributes: GOOD_SHEET });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const s = await get('/api/state');
    const p = s.json.slots[0];
    assert.equal(p.name, 'Bram');
    assert.equal(p.class, 'Brute');
    // Class bonus is part of what the player has, so the displayed attributes are allowed to add up to more
    // than 10; the allocated points underneath are the ones that were spent.
    assert.equal(p.sheet.allocated.might + p.sheet.allocated.agility + p.sheet.allocated.grit + p.sheet.allocated.focus + p.sheet.allocated.awe, 10, 'the sheet underneath does not spend the pool');
    assert.equal(p.sheet.points, 10, 'the sheet does not say what it spent');
    assert.equal(p.attributes.might, 4, 'the Brute bonus never reached the sheet');
    assert(typeof p.sheet.trick === 'string' && p.sheet.trick.length > 8, 'no class trick on the card, so the class is three words of flavour');
    assert(Object.keys(p.materials).length >= 1, 'the starting kit never arrived');
  });

  await t('a room can be described without a GPU, and hostile words stay words', async () => {
    // No generate flag: describing a room costs nothing. The traversal attempt matters because a description
    // is also a prompt and part of a filename, so it must never become a path.
    const r = await post('/api/scene', { description: '../../../../Windows/win.ini', generate: false });
    assert.equal(r.status, 200, r.text.slice(0, 120));
    const here = (await get('/api/state')).json.place;
    assert.equal(here.description, '../../../../Windows/win.ini', 'the description was quietly rewritten');
    for (const subject of ['../../../../Windows/win.ini', '../../evil', '..\\..\\windows']) {
      const id = assetId({ kind: 'item', subject_id: subject });
      assert(!/[\\/]|\.\./.test(id), `a subject id can escape the art directory: ${id}`);
      assert(!existsSync(`game/art/${subject}.png`), `a render was written outside the style directory: ${id}`);
    }
    assert(slug('../../etc/passwd') === 'etc_passwd', `slug let a path through: ${slug('../../etc/passwd')}`);
    assert(!readdirSync('game/art').includes('..'), 'the art directory listing is not sane');
  });

  await t('a subject id cannot write a picture outside game/art', async () => {
    // The hole this test exists for: assetId() handed back the request's subject_id verbatim, and a render is
    // saved at join(ART_DIR, `${style}/${id}.png`). So POST {"subject_id":"../../../../Users/me/evil"} was an
    // arbitrary file write with PNG bytes, on a route any local page could aim at.
    const before = readdirSync('game/art').join(',');
    const doomed = ['../../../../Windows/evil', '..\\..\\evil', '../../../Users/public/evil'];
    for (const subject_id of doomed) {
      const r = await post('/api/art/generate', { kind: 'environment', subject_id, prompt_hint: 'a room' });
      // Either refused outright, or refused by the renderer for a reason that is not "I wrote your file".
      if (r.status === 200 && r.json?.ok) assert(!/[\\/]\.\./.test(String(r.json.file || '')), `the server reported writing ${r.json.file}`);
    }
    assert(readdirSync('game/art').join(',') === before, 'a POST added or removed an entry in game/art');
    for (const evil of ['../../../../Windows/win.ini', '..\\..\\evil', 'a/b/c', '...', '/etc/passwd']) {
      const id = assetId({ kind: 'item', subject_id: evil });
      assert(/^[A-Za-z0-9_-]+$/.test(id), `an asset id contains a character no filename stem should have: ${id}`);
      assert(id.length <= 64, `an asset id is ${id.length} characters long`);
    }
  });

  await t('a face needs a sentence, not a shrug', async () => {
    // 400 here is the last cheap refusal before a GPU render, so it must not depend on ComfyUI being up.
    const r = await post('/api/portrait', { description: 'a guy' });
    assert.equal(r.status, 400, r.text.slice(0, 120));
    assert(/sentence|paint/i.test(r.json.error), r.json.error);
  });

  console.log('\n== the story is state, and so is the seat lock ==');

  await t('a played round becomes the telling, with the round it belongs to', async () => {
    await post('/api/intent', { slot: 1, text: 'I push the door open' });
    const r = await post('/api/round', {});
    assert.equal(r.status, 202, 'a DM turn must be answered immediately and finished on SSE');
    for (let i = 0; i < 60; i++) {
      const s = await get('/api/state');
      if (s.json.round >= 1 && s.json.telling?.round >= 1) {
        assert(typeof s.json.telling.text === 'string' && s.json.telling.text.length > 8, 'telling is empty');
        assert.equal(typeof s.json.telling.bark, 'boolean');
        return;
      }
      await new Promise((s2) => setTimeout(s2, 250));
    }
    assert(false, `round never landed. Server said: ${output.slice(-300)}`);
  });

  await t('a seat that has played cannot be re-declared, and says why', async () => {
    const r = await post('/api/seat', { slot: 1, name: 'Someone Else', cls: 'Cutter', attributes: GOOD_SHEET });
    assert.equal(r.status, 400, 'rerolling a character mid-adventure was accepted');
    assert.equal(r.json.rejected[0].code, 'SEAT_TAKEN');
    assert(/played \d+ round/.test(r.json.rejected[0].reason), r.json.rejected[0].reason);
    const p = (await get('/api/state')).json.slots[0];
    assert.equal(p.name, 'Bram', 'the refusal happened and the character changed anyway');
  });

  await t('the state describes a table, not a debug dump', async () => {
    const s = (await get('/api/state')).json;
    assert.equal(s.law.points, 10, 'the law the form builds against is missing or different');
    assert(Array.isArray(s.seats_open) && s.seats_open.every((n) => [2, 3, 4].includes(n)), 'seats_open wrong for this table');
    assert(s.place && s.place.id, 'no place in state');
    assert(s.mode === 'fake-dm', `a --fake-dm server claimed ${s.mode}`);
    assert(typeof s.order_seed === 'string' && s.order_seed.length >= 8, 'the order seed a roll is derived from is missing');
    // What a public endpoint may not carry is the engine's own dump: the transcript, the render queue, and the
    // provenance of a derived number (which materials paid for a tier, who owns an item). A {id, name, tier}
    // list of what is in play is the deck, and every one of those facts is already visible on the table.
    for (const secret of ['log', 'queue', 'save', 'world_hash', 'settings']) {
      assert(!(secret in s), `"${secret}" is engine internals, and it is on a public HTTP endpoint`);
    }
    for (const it of s.items || []) {
      for (const internals of ['derived', 'materials_spent', 'recipe', 'owner', 'source_mutation']) {
        assert(!(internals in it), `the item list exposes "${internals}", which is how a stat line gets read aloud`);
      }
    }
  });

  await t('a route nobody wrote answers 404, and never a 500', async () => {
    const a = await get('/api/nonexistent');
    assert.equal(a.status, 404);
    const b = await fetch(`${BASE}/api/seat`, { method: 'DELETE' });
    assert([404, 405].includes(b.status), `DELETE /api/seat answered ${b.status}`);
    const c = await post('/api/intent', { slot: 2, text: 'I do a thing' });
    assert.equal(c.status, 400, 'an intent from an empty chair must be refused');
    assert(/not seated/.test(c.json.error), c.json.error);
  });

  console.log('\n== survival ==');
  await t('a hundred bad requests leave the server standing', async () => {
    const bodies = ['{', '[', 'null', '"x"', '{}{}', '', '0'];
    for (let i = 0; i < 14; i++) await post('/api/seat', bodies[i % bodies.length]);
    const s = await get('/api/state');
    assert.equal(s.status, 200);
    assert(alive(), 'the server exited after hostile input');
  });
} catch (e) {
  fail += 1;
  console.error(`FAIL  suite crashed: ${e.message}`);
  console.error(output.slice(-1200));
} finally {
  // ----------------------------------------------------------------------------------------------
// One round at a time, and nobody's words evaporate inside it.
//
// A real game master turn is tens of seconds and there is exactly one table. Nothing stopped two
// rounds resolving against it at once, which the 2026-11-10 review measured with a deliberately slow
// stub (test/redteam/dm-stub.mjs, 2s a turn): the wood was spent twice and one club appeared; an intent
// posted during a turn got HTTP 200 and then vanished with the rest of the intent list; and /api/new
// mid-turn left the fresh table wearing the previous campaign's telling. The stub is imported here at
// 1.2s so the overlap is real rather than imagined - a mock would pass these three by construction.
// ----------------------------------------------------------------------------------------------

const SPORT = PORT + 1, GPORT = PORT + 2;
const SBASE = `http://127.0.0.1:${GPORT}`;

console.log('\n== one round at a time (slow game master, genuine overlap) ==');

const stubUp = await fetch(`http://127.0.0.1:${SPORT}/v1/models`).then(() => 'busy').catch(() => 'free');
const gameUp = await fetch(`${SBASE}/api/state`).then(() => 'busy').catch(() => 'free');
if (stubUp === 'busy' || gameUp === 'busy') {
  console.error(`FAIL  port ${stubUp === 'busy' ? SPORT : GPORT} is already answering. This suite will not drive a process it did not start.`);
  running = false; child.kill('SIGKILL'); process.exit(1);
}

const stub = spawn(process.execPath, ['test/redteam/dm-stub.mjs'], {
  env: { ...process.env, STUB_PORT: String(SPORT), DM_DELAY_MS: '1200' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let stubOut = '';
stub.stdout.on('data', (d) => { stubOut += d; }); stub.stderr.on('data', (d) => { stubOut += d; });
const slow = spawn(process.execPath, ['game/server.mjs'], {
  env: { ...process.env, DB_GAME_PORT: String(GPORT), DB_PERSIST: '0', DB_TTS_URL: '', DB_DM_URL: `http://127.0.0.1:${SPORT}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let slowOut = '';
slow.stdout.on('data', (d) => { slowOut += d; }); slow.stderr.on('data', (d) => { slowOut += d; });
const slowAlive = () => slow.exitCode === null && slow.signalCode === null;

const spost = async (path, body) => {
  const r = await fetch(`${SBASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let j; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
};
const sget = async (path) => (await fetch(`${SBASE}${path}`)).json();

if (!slowAlive()) {
  console.error('FAIL  the slow-DM server never started');
  console.error(slowOut.slice(-1200));
} else {
  let up = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 20_000) {
    if (!slowAlive()) break;
    if ((await fetch(`${SBASE}/api/state`).then(() => true).catch(() => false))) { up = true; break; }
    await new Promise((s) => setTimeout(s, 120));
  }
  if (!up) {
    console.error('FAIL  the slow-DM server never answered /api/state');
    console.error(slowOut.slice(-1200));
    fail += 1;
  } else {
    await t('a name the rules refuse is a 400 with a code, never a 500 with a thrown error', async () => {
      const r = await post('/api/seat', { slot: 4, name: 'x', cls: 'Brute', attributes: GOOD_SHEET });
      assert.equal(r.status, 400, `a one-letter name threw inside the engine until 2026-11-10; the seat route answered 500 and the client called it a server fault`);
      assert.equal(r.json.rejected[0].code, 'NAME_REJECTED', JSON.stringify(r.json));
      assert(r.json.rejected[0].allowed.length >= 2, 'the refusal has to hand back the shape a name has');
    });

    await t('one round at a time: the second POST is refused, and the table pays for exactly one turn', async () => {
      await spost('/api/new', {});
      for (const [slot, name, cls] of [[1, 'Bram', 'Brute'], [2, 'Ash', 'Cutter']]) {
        const s = await spost('/api/seat', { slot, name, cls, attributes: GOOD_SHEET });
        assert.equal(s.status, 200, `seat ${slot}: ${JSON.stringify(s.body)}`);
      }
      await spost('/api/intent', { slot: 1, text: 'I craft a club from wood and sinew' });
      await spost('/api/intent', { slot: 2, text: 'I watch' });

      const before = await sget('/api/state');
      const [a, b] = await Promise.all([spost('/api/round', { n: 1 }), spost('/api/round', { n: 1 })]);
      assert.equal(a.status, 202, 'the first POST is accepted');
      assert.equal(b.status, 409, `the second POST during a resolving turn must be refused, got ${b.status} ${JSON.stringify(b.body)}`);
      assert(b.body.in_flight, 'and must name the round it is refusing to stack');

      // Still inside the same turn: words that arrive now cannot join a prompt that is already written,
      // and /api/new would wipe a table the turn is about to write on.
      const mid = await spost('/api/intent', { slot: 2, text: 'I shout a warning' });
      assert.equal(mid.status, 200);
      assert.equal(mid.body.in_flight, true, 'the server has to say the turn is in flight, not imply it');
      assert(mid.body.queued_for_round >= 2, `and say when the words land: ${JSON.stringify(mid.body)}`);
      const reset = await spost('/api/new', {});
      assert.equal(reset.status, 409, `starting over mid-turn is refused, got ${reset.status}`);

      const settled = await until(async () => {
        const s = await sget('/api/state');
        return s.telling.round > 0 ? s : null;
      }, 15_000);
      assert(settled, `the turn never landed (server said: ${slowOut.slice(-300)}`);
      const wood = settled.slots[0].materials.wood;
      assert.equal(wood, before.slots[0].materials.wood - 2, `one club costs two wood, not four: ${JSON.stringify(settled.slots[0].materials)}`);
      assert.equal(settled.slots[0].carrying.filter((i) => /club/i.test(i.name)).length, 1, 'one club appeared');
      assert.equal(settled.slots[1].intent, 'I shout a warning',
        'a player who spoke during the turn got HTTP 200 and used to lose the words entirely: they have to survive into the round they were promised');
      const after = await spost('/api/new', {});
      assert.equal(after.status, 200, 'once the turn lands the table can start over - a guard that cannot be got past is a lock, not a law');
    });
  }
}

running = false;
stub.kill('SIGKILL');
slow.kill('SIGKILL');

  child.kill('SIGKILL');
  // Kill the tree: a Windows child of node can outlive its parent, and a server left on this port makes the
  // next run of this file test the wrong process.
  await new Promise((s) => setTimeout(s, 250));
}

console.log(`\nhttp: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
