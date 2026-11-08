# D20 — physics as theatre, the tracker as law

```js
const table = new DiceTable(el, { onStage, onImpact });
const { landed, agree } = await table.roll({ value: 17, seed: 4242 });
```

The **tracker rolls the number**. The renderer is only ever told a number and obeys it, then
asserts that what it showed matches what it was told. `landed !== value` is not a visual
glitch, it is a rules break, and it resolves `agree: false` so the caller can scream.

`spikes/` is explicitly not law — this is a spike, kept to show the shape of the seam.

## Verified, in a headless browser, on this machine

| Claim | Evidence |
|---|---|
| The die never contradicts the tracker | `?selftest=1` runs 25 rolls (1–20 plus repeats) and asserts `landed === value`: **PASS 25/25, mismatches: none** |
| It draws | frames captured at t=0.30 / 0.52 / 2.60 s: bone d20 airborne over torchlit dirt, contact shadow, dust plume, ring shockwave, die settled showing the announced face |
| Numbers are right side up | atlas UVs map each facet by real geometry, apex vertex to cell top, winding preserved so nothing is mirrored |
| The die stays in frame | damped track rig on camera and aim, in x and z |
| The seam is honest | `upFace()` reads the die's actual orientation and is compared against the announced value every roll |

**Known not-working:** settle median and worst are both exactly **2.35 s**, which means every
roll ends on the timeout, not because the die came to rest. The die does bounce and skitter,
but it is still creeping at `settleMs`. Fix is damping (`angDamp`/`linDamp` up, or
`restLin`/`restAng` thresholds up), not the law. Until then the roll length is a fixed
~2.35 s, which happens to sit right in the window for covering the DM's first token.

## The four bugs the headless pass caught, none of which `node --check` could see

1. **`ReferenceError: now is not defined`** — extracting the loop body into `step()` left a
   `now` behind in the animation loop. The page died on frame one and looked exactly like a
   dark room.
2. **`dq.multiplyScalar is not a function`** — three.js `Quaternion` has no `multiplyScalar`.
   Angular integration died on the same frame one.
3. **21 of 25 rolls showed the wrong number.** `_beginEase` rotated the face that was
   *already up* onto +Y — a no-op dressed as a correction. The announced face is the one that
   must go to +Y. This was reported as success by a passing build.
4. **The test harness itself lied.** `pump()` is synchronous, so `promise.then()` (a microtask)
   could not run inside it; 25 rolls that all settled correctly were reported as "never
   settled". And the landed payload carried `value`/`ms` while the HUD read `target`/`sim_s`,
   so a perfectly legal die printed `*** DISAGREEMENT ***` for every roll.

Four layers — code, harness, payload contract, rendering — each failing quietly in a different
direction. The one thing that caught all four was **making the page report its own errors and
then looking at it**.

## Files

- `d20.js` (~540 lines) — scene, rigid body, number atlas, procedural dirt, dust, rings,
  torch light, track camera. No assets, no CDN.
- `index.html` — HUD, seeded throw, NAT 20 / NAT 1 flash, synthesised thud, and the
  self-test. Also installs `window.onerror` → HUD, because a spike that fails silently is
  worse than one that fails.
- `three.module.js` — vendored three r160, no network at runtime.

## Open questions for the real client

- **Does the ease read as cheating?** The settle masks it with a slow-mo dip and dust, and the
  better long-run fix is seeding the throw so the natural resting face *usually is* the
  announced one and the ease becomes the exception.
- 60 fps on the 4060 next to a busy llama-server: unmeasured. The renderer is not trivial
  (shadow map, bump map, ~400 particles); it needs measuring against a live DM turn.
- 4P couch layout: the roll should probably be full-bleed for ~2 s, not a card.
