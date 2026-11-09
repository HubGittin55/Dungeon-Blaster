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
