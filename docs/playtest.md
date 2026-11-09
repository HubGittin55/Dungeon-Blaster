# Play test sheet

## Run it

    .\launch-alpha.ps1            # DM + audio + ComfyUI if not already up, then the table at http://127.0.0.1:8765

Already-running servers are reused and **only what the launcher started gets stopped**. `npm run play` is the
same thing with a scripted DM (no model, no GPU) if you want the loop without the wait. `npm test` is 109
assertions: 30 gate/evil-bot, 8 turn, 71 ignore-rule.

## What is real

- **The tracker is the only thing that decides anything.** The model proposes `resolve_round`; the gate
  commits it or rejects the whole round, and a rejected round changes nothing on the table.
- **Rolls come from `crypto.randomInt` in the server.** The die animation is told the number; it cannot
  produce one. No `?value=` means a `?` on screen, not an invented roll.
- **Art is pre-generated.** 40 assets in the Anato Finnstark style ship in `game/art/finnstark/`, all
  32 raw materials plus the static furniture. A card that
  has no asset says so and queues the job; the game never blocks a narration on a render.
- **Art style is a setting** (gear, top right) and it reports how many assets each style has actually
  rendered. Four styles currently offer zero.

## Try these

1. **Craft something out of what you hold.** The crafting gate is the strongest thing to feel: ask for
   moonglass and the round is rejected with the real material names attached.
2. **Hand an item to another player, then ask the recipient to craft with it.** The gate charges the
   *crafter's* inventory, so transfer first or the craft fails.
3. **Roll on something with a real stake.** Watch that the number in the reveal is the number the log says.
4. **Say something impossible** (a material that does not exist, an item nobody is holding, an XP award to
   an empty chair). Every one of those should produce a bark, not a lie.
5. **Open the gear menu and pick a style with 0 rendered.** The game should say the art it served came from
   elsewhere rather than pretending.
6. **AFK a slot.**

## Known warts, so your notes aim at the right things

- **Narrator voice is off** unless `DB_TTS_URL` is set. Text narration only, this pass.
- **One mic, four players.** Speaker attribution is unsolved; intents are labelled by whoever is seated.
- **Fallback rounds speak a stock line** like "The moment lands, scuffed at the edges." That means the model
  proposed something illegal twice and the gate refused both - the law worked, the scene got thinner. Log the
  rejection code if you see one of these.
- **The die is deliberately unmarked.** If you want to know whether it is lying, it cannot be: the number is
  text drawn over a blank die after it settles.
- **Combat is not in the rules.** No damage tool exists, so the tracker records no harm and no hit points.
  The DM can describe a wound; nothing counts it.
- **Two art engines, two jobs**: Qwen Image 2.1 for anything built ahead of time (icons, text, backdrops),
  Anima for anything generated at the table (2-3s, low VRAM). Runtime generation is not wired into the loop
  yet - it is queued and displayed, never blocking.
- **Settings style does not restyle cards already on screen.** Every asset carries the style it was rendered
  with; that is the same property that keeps an item looking like itself all session.
