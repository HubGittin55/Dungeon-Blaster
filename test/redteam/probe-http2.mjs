// Concurrency probes against the LIVE-DM server on :8765 with a 2s-delay DM stub on :8080.
const BASE = 'http://127.0.0.1:8765';
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

// --- B2. two concurrent /api/round with a slow DM ---
console.log('== B2. two concurrent POST /api/round, slow DM ==');
await seatAll();
let st = await get('/api/state');
console.log('before: slot1 materials =', JSON.stringify(st.body.slots[0].materials), 'round =', st.body.round);
await post('/api/intent', { slot: 1, text: 'I craft a club from wood and sinew' });
await post('/api/intent', { slot: 2, text: 'I look around' });
const t0 = Date.now();
const [r1, r2] = await Promise.all([post('/api/round', { n: 1 }), post('/api/round', { n: 1 })]);
console.log(`both POSTs answered in ${Date.now() - t0}ms: ${r1.status}, ${r2.status}`);
await sleep(6000); // two 2s DM turns + margin
st = await get('/api/state');
console.log('after: round =', st.body.round, '| slot1 materials =', JSON.stringify(st.body.slots[0].materials),
  '| slot1 carrying =', JSON.stringify(st.body.slots[0].carrying.map((c) => c.name)));
console.log('telling =', JSON.stringify(st.body.telling));

// --- C2. intent posted mid-round (during the 2s DM delay) ---
console.log('\n== C2. intent posted mid-round ==');
await seatAll();
await post('/api/intent', { slot: 1, text: 'I craft a club from wood and sinew' });
const roundP = post('/api/round', { n: 1 });
await sleep(500); // round is in flight (DM takes 2s)
const mid = await post('/api/intent', { slot: 2, text: 'I shout a warning' });
console.log('mid-round intent POST ->', mid.status, JSON.stringify(mid.body));
await roundP;
await sleep(3000);
st = await get('/api/state');
console.log('after round: round =', st.body.round, '| slot2 intent =', JSON.stringify(st.body.slots[1].intent),
  '| telling =', JSON.stringify(st.body.telling.text));

// --- D2. /api/new mid-round ---
console.log('\n== D2. /api/new mid-round ==');
await seatAll();
await post('/api/intent', { slot: 1, text: 'I craft a club from wood and sinew' });
const rp2 = post('/api/round', { n: 1 });
await sleep(500);
const nw = await post('/api/new', {});
console.log('/api/new mid-round ->', nw.status);
await rp2;
await sleep(3000);
st = await get('/api/state');
console.log('after: round =', st.body.round, '| seats =', JSON.stringify(st.body.slots.map((s) => s.seated)),
  '| slot1 materials =', JSON.stringify(st.body.slots[0]?.materials),
  '| telling =', JSON.stringify(st.body.telling));
