// Live HTTP probes against game:fake on :8765 (d73ba44).
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765';
async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  return { status: r.status, body: j };
}
async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, body: await r.json() };
}
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
// A probe that drives whatever happens to be listening says nothing about the build under review. Three
// stale servers from earlier sessions were sitting on 876x when this ran the first time, and one of them
// predated /api/seat - so an HTTP finding from before this guard existed may have been a finding about a
// build that was not the one being reviewed. `telling` arrived with the build under review; if the
// listener does not have it, refuse to run rather than measure the wrong process.
async function preflight() {
  let s;
  try { s = await (await fetch(`${BASE}/api/state`)).json(); }
  catch (e) { throw new Error(`nothing answering GET ${BASE}/api/state: ${e.message}`); }
  if (!s || typeof s !== 'object' || !('telling' in s) || !('npcs' in s)) {
    throw new Error(`${BASE} is a server that predates the build under review (no telling/npcs in state). `
      + 'Find it and stop it: netstat -ano | findstr LISTENING, then Stop-Process -Id <pid>. Not testing the wrong process.');
  }
  console.log(`preflight ok: ${BASE} is the build under review (round ${s.round}, campaign ${s.campaign})`);
}
await preflight();


async function seatAll() {
  await post('/api/new', {});
  const sheets = [
    { slot: 1, name: 'Bram', cls: 'Brute', attributes: { might: 3, agility: 2, grit: 2, focus: 2, awe: 1 } },
    { slot: 2, name: 'Ash', cls: 'Cutter', attributes: { might: 2, agility: 3, grit: 2, focus: 2, awe: 1 } },
    { slot: 3, name: 'Sable', cls: 'Charmer', attributes: { might: 1, agility: 2, grit: 2, focus: 3, awe: 2 } },
    { slot: 4, name: 'Piper', cls: 'Brute', attributes: { might: 3, agility: 2, grit: 2, focus: 1, awe: 2 } },
  ];
  for (const s of sheets) {
    const r = await post('/api/seat', s);
    if (r.status !== 200) throw new Error(`seat ${s.slot} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
}

// --- A. /api/seat with an invalid name ---
console.log('== A. /api/seat invalid name ==');
await post('/api/new', {});
let r = await post('/api/seat', { slot: 1, name: 'x', cls: 'Brute', attributes: { might: 3, agility: 2, grit: 2, focus: 2, awe: 1 } });
console.log(`name "x" (too short) -> HTTP ${r.status}: ${JSON.stringify(r.body)}`);
r = await post('/api/seat', { slot: 1, name: 'system', cls: 'Brute', attributes: { might: 3, agility: 2, grit: 2, focus: 2, awe: 1 } });
console.log(`name "system" (reserved) -> HTTP ${r.status}: ${JSON.stringify(r.body)}`);
r = await post('/api/seat', { slot: 1, name: 'Blade! @%', cls: 'Brute', attributes: { might: 3, agility: 2, grit: 2, focus: 2, awe: 1 } });
console.log(`name "Blade! @%" (charset) -> HTTP ${r.status}: ${JSON.stringify(r.body)}`);

// --- B. concurrency: two POST /api/round at once, both crafting ---
console.log('\n== B. two concurrent POST /api/round ==');
await seatAll();
let st = await get('/api/state');
console.log('before: slot1 materials =', JSON.stringify(st.body.slots[0].materials), 'round =', st.body.round);
await post('/api/intent', { slot: 1, text: 'I craft a club from wood and sinew' });
await post('/api/intent', { slot: 2, text: 'I look around' });
// fire two rounds concurrently
const [r1, r2] = await Promise.all([post('/api/round', { n: 1 }), post('/api/round', { n: 1 })]);
console.log(`round POST 1 -> ${r1.status}, POST 2 -> ${r2.status}`);
await sleep(1500);
st = await get('/api/state');
console.log('after: round =', st.body.round, '| slot1 materials =', JSON.stringify(st.body.slots[0].materials),
  '| slot1 carrying =', JSON.stringify(st.body.slots[0].carrying.map((c) => c.name)),
  '| slot2 carrying =', JSON.stringify(st.body.slots[1].carrying.map((c) => c.name)));
console.log('telling =', JSON.stringify(st.body.telling));

// --- C. intent posted mid-round is wiped ---
console.log('\n== C. intent posted during a round ==');
// The fake DM resolves in ms, so use a slower observable: post intent, fire round, immediately post another intent.
await seatAll();
await post('/api/intent', { slot: 1, text: 'I craft a club from wood and sinew' });
const roundP = post('/api/round', { n: 1 });
await post('/api/intent', { slot: 2, text: 'I shout a warning' });
await roundP;
await sleep(1200);
st = await get('/api/state');
console.log('after round: slot2 intent =', JSON.stringify(st.body.slots[1].intent), '| round =', st.body.round);

// --- D. /api/new mid-round (reset during play) ---
console.log('\n== D. /api/new during a round ==');
await seatAll();
await post('/api/intent', { slot: 1, text: 'I craft a club from wood and sinew' });
const rp2 = post('/api/round', { n: 1 });
await post('/api/new', {});
await rp2;
await sleep(1200);
st = await get('/api/state');
console.log('after reset+round: round =', st.body.round, '| seats =', JSON.stringify(st.body.slots.map((s) => s.seated)),
  '| telling =', JSON.stringify(st.body.telling));

// --- E. transfer qty>held over HTTP (via a crafted round? not directly exposed; engine-level only) ---
console.log('\n== E. (engine-level findings above are not HTTP-exposed; see probe-engine.mjs) ==');
