# Design log

## 2026-11-09 - art style is a setting; the die stops claiming anything

**Style ranking (Blarmo):** 1. Shinkai, 2. Bengal, 3. Gerph, 4. Minillustration.
Mita was rendered in the bake-off and not ranked, so it is not offered. Style becomes a
player-facing setting, not a build-time constant: `game/art/styles.mjs` is the registry, the
menu writes a key into game state, and every generated or pre-generated asset records the style
it was made with, because a restyle must be a re-batch and not a silent remix of two styles in
one gallery. Anima takes styles as `@artist` tags, so a new style is a registry entry plus a
batch. Blarmo's note for later: Anima gives cartoon/anime without help, so a painterly
illustration style wants a LoRA - not now.

**Dice roll, simplified (Blarmo):** one canned animation, no readable numbers while it rolls,
then fade the number in on the top face at the end.

The reason this is the right call and not a dodge: every bug I have had with the d20 is the same
bug, and it is that the die *asserts* something. The printed glyph is a claim about the result, so
it can disagree with the tracker, and then the page has two answers and only one of them is law.
Three separate fixes (UV atlas, ease target, glyph yaw) each made the claim more careful and none
made it true, and the measurement says the die currently prints its own announced number upside
down on 19 of 26 rolls. An unmarked die makes no claim. The number arrives as a reveal, from the
tracker, in screen space, where it cannot be mirrored, rotated, or mis-uploaded. The law stops
being "the die must show the announced number" and becomes "the reveal must be the announced
number", which is a string comparison rather than a projection I have to trust.

Kept: the raw spike page with the marked die and `?selftest=1`, still failing, because the
25-roll physics/agreement suite and the legibility measurement are the reason I know any of this.
The canned roll is what the game uses; the spike stays as the evidence.

## 2026-11-09 - two engines, two jobs (Blarmo's ruling, after the full Qwen Image 2.1 set)

Qwen Image 2.1 took the whole static set: icons, text, and overall coherence are clearly better, and the
alpha channel is genuinely cut out rather than painted. Anima keeps one real edge and it is not mainly
style - it is **2-3 seconds and low VRAM**, which is what runtime generation costs, plus character art
that reads more like hand-made illustration than diffusion.

So the split is by when the picture is needed, not by which model is "better":

- **Build time** (icons, UI, backdrops, anything with lettering): Qwen Image 2.1 at 0.5-1MP. 11s per icon
  is free, because nobody is waiting at the table.
- **Table time** (a character or an invented item appearing on a card mid-session): the fast low-VRAM path,
  i.e. Anima. A cold render that lands mid-narration steals the line from TTS, so this stays opt-in and
  asynchronous - queue the job, show a placeholder, fill the card when it arrives.

That also retires a claim I made earlier and recorded here: "art is pre-generated, ComfyUI is a build-time
tool." True for everything with a fixed identity, because those assets must look the same twice. False as
a law, because determinism does not require pre-generation - it requires a seed derived from identity,
which `pregen.mjs` already does with `sha256(style:id)`. A runtime render of "Goblin-Bane Longsword" with
that seed is stable across sessions and still costs 2-3s instead of a manifest entry.

Lettering is one string, not five. `LETTERING` in `pregen.mjs` names the letterforms and every text asset
composes from it; `TEXT_RULES` says exactly-that-text-and-nothing-else, because left alone the model adds a
subtitle. Baked text is still only for things that never change: a title yes, "3 of 4 players joined" no.

## 2026-11-09 - why nobody has seen a screenshot of the client

`game/client/index.html` opens `new EventSource('/api/events')` unconditionally on line 141. A page with an
open stream is never finished loading, so `msedge --headless --dump-dom --virtual-time-budget=N` never
reaches the point where it prints: two attempts hung (one for 400s, one for 220s) and produced nothing.
That is a testability hole, not an Edge quirk - and a client nobody can render headlessly is a client whose
visual regressions are caught by a human eyeballing a laptop.

Provable fix, not yet done: let the page be rendered without a live stream (a probe flag that skips the
EventSource, or the server closing it once the client says it is ready). Then a headless dump is a real
assertion - grep the DOM for content that only exists if the JavaScript ran.

Until then, be precise about what is verified for the settings menu: the HTTP surface is verified by
requests (default, valid POST, malformed body 400, unknown style falls back and says so, choice survives a
restart), the panel's JS parses with a real exit code, and the markup is served. The rendered panel has not
been seen. Saying "menu works" would be a claim about pixels I have not looked at.

## 2026-11-10 - which engine draws what (a correction from the couch)

The art policy is now Blarmo's, not my inference: **crafting materials are a fixed vocabulary, so they are
drawn once at build time; everything that exists only because the table said so is drawn at the table.**

My first pass had this backwards. "Paint the room" went through the build engine because the result would
"match the look" of the forty shipped cards - 20 seconds of waiting to protect an aesthetic, and a fork on
engine, which is the thing the style registry already decided against (a style is an `@artist` tag, not a
pipeline). The game's whole trick is saying a thing and seeing it, so the build engine is banned from turns.

What I should have fixed instead: the manifest keyed one file per asset id, so a table render of `scene_start`
*shadowed* the pre-drawn card and the shipped art became unreachable. Keyed by (id, style directory) now, with
the same rule written in two places that have to agree (`art.mjs` record, `pregen.mjs` merge):

- 32 material cards: `finnstark/`, build engine, rendered once, shown as crafting materials.
- 4 rooms: `finnstark/scene_*.png` from the batch, `shinkai/scene_start.png` painted at the table in 3.6s.
- faces: class stock portraits from the batch, plus any face a player described (`face_<hash of words>`).
- items: runtime only. Every item picture in the game was drawn because somebody made the thing.

Two things that fell out of doing it this way:

**The words are the identity.** `seed = sha256(style:id:prompt)`, so "a flooded crypt, ankle-deep black water,
funeral niches bricked shut" paints the same crypt next Saturday. Re-painting a room with *new* words is a new
room - which is why the manifest-first shortcut lives in the caller (an item that is painted stays painted)
and not inside the render function (a location with new words in it must never be served the old picture).

**A placeholder has to say what it is standing in for.** The moment a club is minted its chip shows the card
of whatever it is mostly made of, dashed, because that is a true picture of its materials and not yet a
picture of itself. When the render lands the state re-emits, the dashed border goes, and the deck gains the
card. Hover text says which of the two you are looking at.

Measured on the 4060 laptop with ComfyUI and the DM both loaded: room 3.6s, face 3.6s, a minted item painted
end-to-end 12s with a round in flight, never blocking the narration.

## 2026-11-10 - a replace whose span you did not check is not an edit

Rewriting `generateArt` with a span-anchored replace deleted three functions that lived between the anchors:
`speak`, `speakNow`, `VOICE_TEST_LINE`, and (already dead) `renderArt`. `node --check` passed, the tests all
passed - nothing but a live round caught it, and it caught it as `ReferenceError: speak is not defined` in a
crashed server. The fix procedure worth keeping: diff the *set of top-level names* against HEAD and print what
vanished. 40 seconds, and it names every casualty instead of the one you happened to click.

## 2026-11-10 - three things the first four-player game with the real DM caught

Played alpha-2026-11-092348 with four seats, the live 35B, and nothing scripted. Rounds took 32-51s, three of
them committed on the first try (`strict`, narration verified), and the table invented a club, a torch, a hook
on a rope, a merchant named Glim, and a Guard Harker - every one of them painted by Anima and looking at the
couch from the CARDS pile within four seconds. Three defects came out of it, and none of them were visible to
any test I already had.

**A rejection that names no legal value is not a correction.** The model cited another seat's intent for a
craft, was told *"must cite an intent issued by slot 4 this round"*, and had four ids on screen with no way to
tell which were slot 4's - so it made the same mistake twice, the round went to the canned bark, and a player
watched their torch become nothing. `NO_INTENT` now says whose id was misused and hands back the ids that seat
actually issued (`allowed` was empty before, which is the part I keep getting wrong: the law's whole promise is
that a refusal teaches).

**A person is a mutation.** One round narrated *"the voice from the niche belongs to a trapped merchant"* and
issued nothing. The prose law - do not describe what your mutations do not create - was not violated in spirit
anywhere near as badly as it should have been, because nothing in the contract said a human being has to be
*registered*. Glim and Guard Harker exist because the model used `introduce_npc`, which means they can be met
again, fought, paid, and painted; a stranger in the adjectives can be none of those. Contract line plus a test
that the line and the schema enum both still exist.

**The telling was an event, not a fact.** Reload the page mid-adventure and the story went back to *"Four of
you wake up in a damp cell"* while the header cheerfully said round 1 and the party stood in the Guard corridor.
Narration that has been heard is state: `telling = {round, text, bark}` now rides in `/api/state`, arrives with
a rejoin, and is painted as plain text (the words came out of a language model, so they do not get to be HTML).
The typewriter stays for narration as it lands - a reload should not re-perform twenty seconds of old news.

Also fixed in the same sweep, both invisible until a human looked: `introduce_npc` rendered portraits into the
manifest that no screen ever asked for (NPCs are cards now, faces and all), and *New table* still logged "four
seats filled" after the seats stopped filling themselves.

## 2026-11-10 - the front door had no test, so four of its laws were already broken

Went to hand this build to an outside reviewer and wrote down "here is how to attack it" first, which meant
checking the claims. That turned into an afternoon of finding my own holes, and the reason they existed is
simple: `gate_test.js` and `turn_test.mjs` cover the rules and the turn contract, and **nothing** exercised the
HTTP surface the browser actually talks to. Four defects, all live, all in code I had read:

- **A malformed JSON body answered 500 with a JavaScript parse error**, on six of seven routes. The repo states
  as law that a malformed POST must 400. The rule was implemented six times by hand, guarded once, and checked
  zero times - so a phone locking mid-request was a server fault, and the client was told it was one.
- **`POST /api/art/generate {"subject_id":"../../../../Windows/evil"}` was an arbitrary file write.** Asset ids
  came from `candidateIds()[0]`, which is the request's own string; renders are saved at
  `game/art/<style>/<id>.png`. The *read* side of the same file had a containment check for a week and the write
  side trusted a browser. Sanitised at the source (a filename stem is `[A-Za-z0-9_-]`, measured against every
  id ever written) and re-checked on the joined path before anything is opened.
- **Answering 413 destroyed the connection**, which poisoned the keep-alive socket: the *next* request hung for
  300 seconds. From the couch that is indistinguishable from a crash, which is the worst property a refusal can
  have. Bodies are now drained and discarded, so the answer arrives and the connection survives; only a genuine
  flood (32 MB of it) gets closed.
- **`"slot": [2]` was a legal way to sit in seat two**, because `Number([2]) === 2` while `"abc"` was correctly
  refused. Coercion that accepts the JSON types nobody means is a hole shaped like convenience.

Plus an unbounded `for await (const c of req)` on a laptop that is also holding a 35B model, a TTS model and an
image renderer.

`test/http_test.mjs` is the fix that matters more than any of the four: it boots the real server as a child
process and drives it with fetch. Deliberately a real process - a mock server answers a 500 by not crashing,
which is the one thing a mock cannot tell you. It refuses to run if its port is already answering, because
testing whatever else is listening on 8799 is how a green run means nothing. Two of my own assertions were
wrong on the first run (`sheet.attributes` is `sheet.allocated`; the order seed is a hex string, not a number)
and one asserted a law I had invented on the spot - the state may carry `{id, name, tier}` for what is in play;
what it may not carry is where a tier came from. 144 assertions now, 16 of them new.

Written up as `docs/redteam-brief.md`: what to attack, in the order I found things, what is already probed, and
- crucially for anyone else's evening - the seventeen behaviours that are laws and look like bugs.

## 2026-11-10 - the review came back, and every finding was the same finding

Stunkus pulled `d73ba44`, wrote six probe scripts, and dropped them in `test/redteam/`. Four of the five
findings were real, they were worse than anything I had found myself, and all four were one mistake:

**A round is the unit of the fiction, and the server never said so out loud.**

The gate validates every mutation in a round against the state at the top of the round, then commits them
all together. That is the design, and it is right - but it means anything two mutations can spend has to
be counted *across* the round, and only one thing was: the loot `claims` map, hand-built for contention.
So `craft 2 wood` twice against 3 wood in the bag validated twice and committed twice, ending the round at
`wood = -1`. Two drops of the same club passed validation twice, and the second commit looked the item up
again after the first had deleted the stack, found `undefined`, and threw `Cannot set properties of
undefined` from inside the commit - over HTTP that is a 500 and a table in a state nobody can name.

**And `qty` was read as `Number.isInteger(a.qty) ? a.qty : 1`, in three places.** One line, repeated, and
it accepted every negative number in JSON. `take qty=-1` conjured loot in the room (stack 2 -> 3) and gave
the taker -1 iron. `drop qty=-1` put wood in your pocket (2 -> 3). `transfer qty=-1` inflated the sender
and emptied the receiver. `transfer qty=5` handed over five copies of a club that existed once, because
nobody ever asked how many were held. Rules line 52 is four words long: "No negative numbers."

The fix is a within-round ledger (`ctx.pool`) that every spend draws through, and it reserves only once a
mutation's whole draw fits, so a craft refused for want of sinew has not quietly spent the party's wood in
a round that commits nothing. Plus a backstop that assumes I forgot one: snapshot, commit, ask
`stateInvariants()` whether the world is still possible - no negative stacks, no zero stacks, no unknown
items, one holder per item, ownership agreeing with who holds it - and if it is not possible, put the
state back and refuse the round with `COMMIT_INVALID`. A law somebody forgets should cost a round, not a
run.

**The HTTP half was the same sentence.** A real game master turn takes tens of seconds and there is one
table. Two `POST /api/round` both got 202 and both resolved: wood spent twice, one club, and one of the
two rounds silently degraded to a fallback bark over the top. A `/api/new` in the middle left the fresh
table wearing the previous campaign's telling. And an intent posted during a turn got HTTP 200 and then
vanished with the rest of the intent list - a player spoke, was acknowledged, and was never heard, which is
the theft the rules forbid in one line ("a failed intent is never a stolen turn") with better manners. So:
one round in flight, 409 with the id of the round that is resolving, `/api/new` refuses to wipe a table
mid-turn and a dropped turn is logged rather than spoken over a campaign it never saw, and a round now
clears only the intents it actually carried, by object identity - a word that arrives during a turn is
told "queued for round 2" and survives to it.

Two findings were *not* bugs, and are worth keeping straight. `award_xp {party:true}` refusing wholesale
because one hero is at the cap is what the written rule says: no character may be at the threshold when an
award is given, so the award is not legal. And a door confirm being burnt by a rejected attempt is
deliberate in the rules - but a *handoff* confirm is not a door, and it was being burnt by a rejection the
tracker caused, so that one moved to commit time.

Three process lessons, all ugly:

- **The probes could not run where they were committed.** They imported `./tracker/engine.js` from inside
  `test/redteam/`, so they had been run from copies elsewhere - which means the scripts in the repo were
  not the scripts that produced the findings. Fixed, and the same fix revealed a worse one:
- **Five stale servers were squatting on 876x**, and one answered `/api/state` while 404ing `/api/seat`:
  a build from before the seat routes. An HTTP finding measured against a stale listener is a finding about
  a build that is not under review. Both probes now refuse to run unless the listener has the fields the
  reviewed build has.
- **I wrote a comment blaming a parser bug I had caused.** My first `charsetRe` used a template literal and
  failed to parse; I wrote that "`$` before a closing backtick is a thing parsers have opinions about",
  which was false - my escaping was wrong, and the same class of typo (a missing paren) took down my own
  test file an hour later. A wrong explanation in the file that fences names is worse than no explanation,
  because the next reader stops looking. Gone.

The probes print; printing is not law. `test/redteam_law_test.mjs` asserts all of it, and then a seeded
fuzzer plays 1,680 rounds of random mutation soup - nasty quantities, invented names, transfers to
yourself, two mutations on one pool - and refuses any run where the engine threw, where the world ended up
impossible, where a refused strict round moved the world, or where `ok: true` came with a rejection
attached. It found a real bug on its first run: my own assertion, which had frozen the round counter as
part of "the world". The counter belongs to the round boundary (`setIntents` advances it), so an attempted
turn consumes a number whether it commits or not. Whether a refused turn *should* be a round is a question
for the rules owner, not something to redefine in a test.
