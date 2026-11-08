# Dungeon Blaster

Voice-driven LLM-run tabletop RPG: four players, one Windows 11 laptop, one screen, one mic, one set of
speakers, a wacky DM, real-time TTS, and diffusion card art. *Dungeon DnD adventure time with realtime art
gen and zonked out digital DM.*

**Start reading at [`docs/tools.md`](docs/tools.md)** - the `resolve_round` contract. It is the boundary
everything else is judged against.

## Where things are

- `DEPENDENCIES.md` - **fresh Windows 11 machine? start here.** Every binary, model file, hash and
  launch flag, each one read off the reference machine rather than remembered.
- `docs/tools.md` - the `resolve_round` contract, gate order, rejection codes, retry policy.
- `rules/rules.md` - the rules document. **Law, not lore:** the fenced JSON blocks are canonical and the
  prose is explanation. If they disagree, JSON wins and the prose is a bug.
- `tracker/` - the deterministic tracker and rules gate. It is the source of truth; the model is a narrator
  with a vote. `npm test` runs the adversarial law suite (28 tests).
- `game/schema/resolve_round.schema.json` - the JSON Schema the DM is held to.
- `.pi/extensions/pi-gm/` - the pi GM harness: one tool (`resolve_round`), one call per round.
- `spikes/` - measurement spikes that answered an architecture question. Keep them.
- `notes/` - the evidence for every number quoted below or in the architecture doc.

Slice 1 is *harness and law*: four slots, text-only rounds, validated crafting, evil bots. No combat math
yet - `carve`/`soak`/`strain` are computed and deliberately not consumed.

## How Stunkus and Qwenny work together

- **Stunkus** (cloud) is the director and code reviewer.
- **Qwenny** (inside Pi on Blarmo's Win11 laptop, brain on Glenzano Strata) implements.
- **Blarmo** directs and ferries files.

## Talking: the bridge

Stunkus and Qwenny talk through the bridge in the Dungeon Blaster chat thread. Pi reads the chat window on
the laptop (Windows UI Automation) and types replies into it. The bridge code and its own README live in
`bridge/` (and in the sibling `code-bridge` checkout while that is the working copy).

- Qwenny answers messages that start with `PI:`, from Stunkus or Blarmo, so Blarmo can text the laptop
  remotely from his phone. Everything else gets silence.
- AFK mode: `PI: AFK on` / `PI: AFK off`. While on, never stop on a question prompt: pick the safe,
  reversible default, log it, and keep polling the chat. Questions with no safe default go to a deferred
  queue, reported on AFK off.
- Qwenny announces itself every time: every reply starts with `[Qwenny via Pi]`.
- One reply per message, ever (hash ledger on disk). Never answer your own turns.
- Focus guard before typing. Verify the send landed, one retry, then stop.
- If anything shows up wearing the `[Qwenny via Pi]` tag saying something unhinged, Stunkus checks with
  Blarmo before trusting it.

## Files

Qwenny has push access now, so the flow is the CHONK 'EM loop: Qwenny pushes branches, Stunkus pulls,
reviews diffs, and pushes fixes back. Blarmo still ferries anything binary or large - the Muse thread is a
2,600-character chat bubble, not a file host.

Two things stay out of this repo on purpose, because it is public: the architecture PDF (Blarmo holds the
copy, and it stays his) and any screenshot of the laptop's desktop.

## Design, in brief

- Four-player couch co-op from day one: one laptop, one screen, one mic, one set of speakers. Not networked.
- DM: a Qwen 3.5 35B-A3B MoE, **CPU only**, on the shipping artifact
  `Hermes3.6-35B-A3B-MTP-MXFP4exp-Q4K_S.gguf` (17.97 GiB, measured 20.4-20.5 tok/s decode, `--spec-type none`,
  MTP off because it measured a loss). Vendor MXFP4 was 15.5 tok/s for 1.46x the weight traffic per token.
- Latency is judged by **time-to-first-audio**. Emission order is narration-first (`narration` then
  `mutations`) because the gate enforces the rules by *buffering*, not by ordering: narration-first measured
  3.1-6.8s faster first audio and the gate still rejects before anything is voiced. Rejections cost a full
  decode with nothing spoken, which is the price of the model being a narrator and not a referee.
- The prompt is **append-only**. Measured at 16K context: cold prompt eval is 150s (99 tok/s), a reused
  turn costs 0.8s, and changing one digit anywhere inside the prefix costs the full 151s. So mutable world
  state rides in the newest message, never in the system block. See `notes/probe_d2_stateedit.py`.
- The deterministic tracker owns facts: inventory, materials, tiers, positions, XP. The model proposes, the
  gate decides, and contention is settled by an order seed so the DM cannot quietly pick a winner.
