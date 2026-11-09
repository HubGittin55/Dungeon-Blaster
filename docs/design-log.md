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
