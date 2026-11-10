# Attack this build

You are pointed at a public repo, `Dungeon Blaster`: a voice-driven, LLM-run tabletop RPG for four people on
one couch. One laptop runs everything: a 35B game-master model on CPU, a deterministic rules tracker, a game
server with a browser client, speech-to-text, text-to-speech, and an image renderer.

Your job is to make it lie, stall, crash, or contradict itself. **Findings, not opinions.** A finding is:

```
command or request  ->  what happened  ->  what should have happened
```

…plus, if you can, a one-line fix or the test that would have caught it. Style, structure, and "I would have
used X" are not findings; there is a design log in `docs/` explaining several decisions you will hate.

## Run it

```
npm test                 # 144 assertions, no GPU, no model, no network
npm run game:fake        # the whole game with a scripted DM. http://127.0.0.1:8765
node test/http_test.mjs  # boots its own server on :8799 and attacks the HTTP surface
```

`npm run game:fake` needs no model at all and plays a full round, including painting the room if ComfyUI
happens to be up on `:8188` (it being down is a supported state, not a crash). The real game master, when there
is one, is a separate llama-server on `:8080` (`DB_DM_URL`) - the game never runs a model in its own process.

## What the machine is actually for

The model **cannot** change the world. It proposes mutations; a deterministic tracker (`tracker/engine.js`)
validates every one against written rules (`rules/rules.md`) and either commits all of them or none. The model
may not propose stats, tiers, prices, or who wins a contest. Narration is released only if it matches what the
gate actually committed — a round where the model narrates something it did not pay for gets replaced by a
stock line. That is the whole design: **a game master that can allocate stats has already decided the
adventure.**

So the interesting questions are not "can it lie" (there is a wall for that) but:

- **can state and narration disagree anyway**, through a path nobody thought to guard;
- **can a mutation that should have been refused get through** — by ordering, by type confusion, by a value
  that is legal where it is checked and illegal where it is used;
- **can the table be stalled or silenced** by something a player says, types, or draws.

## Places worth attacking, in rough order of what I found last time I tried

1. **Concurrency.** One `POST /api/round` is one DM turn, and intents arrive from four browser tabs on their
   own clocks. Two screens racing to take the same seat, two rounds triggered at once, an intent arriving
   *while* a round is resolving, an SSE client reconnecting mid-round. I have not tested any of this properly.
2. **Prompt injection through the things players control.** Material names, item names, character names, room
   descriptions and face descriptions all become prompt text and *filenames*. The build's own contract lives in
   `game/schema/resolve_round.schema.json`; put a sentence like that in a character name and see what the model
   does with it, and whether the tracker obeys it.
3. **The art path.** Runtime renders are painted from strings the table typed. Ids are sanitised now, and
   `GET /art/...` and the write path both check they stay under `game/art/`. Prove that or find the third path.
4. **The two art engines and the manifest.** Material cards are pre-drawn; invented things are drawn live and
   appended to `game/art/manifest.json`, keyed by (id, style). Corrupt it, truncate it, fill it with records
   pointing outside the tree, run two servers against one working copy, delete a file the manifest still
   names. It must degrade to "no picture, here is why", never a white screen and never a crash.
5. **Long sessions.** 50 rounds with four players, art pending, TTS down, and the manifest at 500 entries.
   Memory growth, `queue.jsonl` growth, SSE reconnect storms, and whether round 40 costs what round 1 costs.
6. **The die.** `POST /api/roll` mints a number in the deterministic layer and the animation is *told* what
   happened. Make the screen show a number that was never rolled, or a roll that never reached the tracker.
7. **The rules themselves.** `rules/rules.md` is law and `tracker/rules_doc.js` parses it into canonical JSON
   with hashes. Try to get the tracker to accept a thing the written rules clearly forbid — a tier from cheap
   materials, an item with no materials, XP to an empty chair, a seat re-declared mid-adventure, a craft that
   spends the same wood twice in one round.

## Already probed — go deeper, don't re-report

Found and fixed on 2026-11-10, all now covered by `test/http_test.mjs`:

- A malformed JSON body answered **500** with a JavaScript parse error on six of seven routes. The repo states
  as law that a malformed POST must 400; the rule was held by six hand-written `JSON.parse` calls and checked
  by nothing.
- An oversized body was buffered without limit on a laptop also holding a 35B model, a TTS model and an image
  renderer.
- Answering 413 without draining the request poisoned the keep-alive connection: the *next* request hung for
  300 seconds, which looked exactly like a crash.
- `POST /api/art/generate` with `{"subject_id":"../../../../Windows/evil"}` was an **arbitrary file write**:
  the asset id was the request's own string, and renders are saved at `game/art/<style>/<id>.png`.
- `"slot": [2]` was a legal way to sit in seat two, because `Number([2]) === 2`.
- A rejection (`NO_INTENT`) that named no legal value, so the model repeated the same mistake twice and the
  round was silenced.

## These are laws, not bugs — please don't spend your evening here

- **A rejected round says almost nothing.** If the gate refuses a mutation twice, the narrator speaks a stock
  line ("Something happens. Somewhat less than something happens."). Correct: it will not voice an unverified
  fact. The rejection codes are in the log.
- **A crafted item first shows the card of its own materials**, with a dashed border, for a few seconds, until
  its live render lands. The hover text says which one you are looking at.
- **Runtime renders are async and never block a round.** 3.6s on a 4060 laptop. A render that fails says so in
  the log and the thing simply has no picture.
- **The d20 has no number on it.** The result is drawn over a blank die after it settles, from the number the
  deterministic layer produced. The animation cannot disagree with the roll, so there is nothing to verify.
- **There is no combat.** No damage tool exists, so no hit points are tracked. The DM can describe a wound.
- **One mic, four players.** Speaker attribution is unsolved; intents are labelled by whoever is seated.
- **The style setting can serve art from another style** when nothing else is rendered — and it says so
  explicitly (`style_matches: false`) rather than pretending.
- **Seats close after the first played round.** Re-declaring a character mid-adventure is `SEAT_TAKEN`: that is
  a reroll. Before round one it is allowed, and the starting kit follows empty hands rather than "first time
  this chair was used".
- **A character's attributes sum to more than 10 on purpose.** 10 points are *allocated*; a class bonus rides
  on top (cap 6). `sheet.allocated` is the truth of what was spent.
- **An image that a language model named can also name a file.** Everything user- or model-authored is escaped
  before it reaches the DOM and sanitised before it reaches the disk; if you find a place where it is not, that
  *is* a finding.

## What to send back

The command, what happened, what should have happened. If you can wrap it in `test/http_test.mjs` or
`test/gate_test.js` and watch it fail, send that too — a hole with a failing test attached gets fixed the same
hour, and a hole without one gets written down and loses the argument to whatever is on fire.

## Added after the first review (commit d1cf90a) - now probed, do not re-report

- **Quantities.** `qty` is a whole number >= 1 or the mutation is refused, on take/drop/transfer, and no
  unit moves on a refused round. Negative quantities no longer add things to the world.
- **Within-round spending.** Two mutations cannot spend the same material, inventory stack or item twice.
  Each legal-alone pair (two crafts, two drops, two handoffs) is refused with a reason that names the
  within-round shortage.
- **Commit backstop.** `stateInvariants()` runs after every commit; if the world is impossible the state is
  rolled back and the round is refused as `COMMIT_INVALID`. Try to make it fire - if you can reach an
  impossible world that the backstop *misses*, that is the best finding available.
- **One round at a time.** `POST /api/round` during a resolving turn answers 409 naming the round in
  flight; `POST /api/new` mid-turn answers 409; a turn that lands after a reset is dropped and logged.
- **Intents survive.** An intent posted during a turn is kept for the next round and the response says so
  (`queued_for_round`, `in_flight`).
- **Names.** `item_name` obeys the charset `rules/rules.md` declares; no name of any kind carries a control
  character; a seat refused for a name is 400 `NAME_REJECTED`, never 500.
- **The fuzz.** `test/redteam_law_test.mjs` plays 1,680 rounds of random mutation soup and fails on a
  throw, an impossible world, a refused strict round that moved the world, or `ok: true` with a rejection
  attached. `DB_FUZZ_SEEDS=...` to add your own seeds; a seed that fails is worth more than a written
  report.
