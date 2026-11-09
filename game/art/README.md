# Art: pre-generated, manifest-resolved

The game serves art from disk. ComfyUI is a **build-time** tool here, not a runtime dependency:

* a cold render must never land in the middle of a spoken line (the DM's first token is already the
  latency bottleneck, and a render steals the card from TTS), and
* the same item should look the same twice, which a fresh seed cannot promise.

So resolution is `subject_id -> file`, and the GPU is only in the loop when a batch is deliberately
run. This is a latency and determinism decision; the licensing question was closed separately by
Blarmo (see `notes/comfyui-anima.md` §6) and does not depend on it.

## Candidate styles

`bakeoff.mjs` renders a fixed trio - `goblin` (creature), `cavern` (location), `club` (item) - across
the candidate `@artist` tags at the shipping settings (640x640, 6 steps, true context-free scale 1,
the shipping negative prompt, same node ids as `server.mjs renderArt`). One variable at a time, so a
style can't be judged on the one subject it flatters.

```
node game/art/bakeoff.mjs                  # 5 styles x 3 subjects, ~30s of GPU
node game/art/bakeoff.mjs club             # one subject, every style
node game/art/bakeoff.mjs goblin gerph     # one cell
```

Outputs land in `C:/dm/art/style/<style>-<subject>.png`, deliberately outside the repo - candidates
are not source, and 15 PNGs at ~500 KB do not belong in git. First run 2026-11-09: 15/15 rendered,
0 failed, ~2.0-2.6s per card, all 15 distinct by SHA (two files shared a compressed byte size, which
is coincidence, not a stuck seed).

| style key | tag |
|---|---|
| `bengal` | `Bengal comic illustration` |
| `shinkai` | `@makoto_shinkai style` |
| `mita` | `@mita_pikazo style` |
| `gerph` | `@gerph style` |
| `mini` | `@minillustration style` |

## Manifest (specified, not yet wired)

`game/art/manifest.json`, written by a batch pass and read by the server:

```jsonc
{ "style": "torchlit-ink-v1",
  "assets": [
    { "id": "item_knotwood_club", "kind": "item", "file": "item_knotwood_club.png",
      "w": 640, "h": 640, "seed": 1106, "tag": "@gerph style" } ] }
```

Resolution the server will use, in order:

1. **manifest hit** - serve the file. No GPU, no variance, this is the normal case.
2. **manifest miss** - emit the job into `game/art/queue.jsonl` and show the style's placeholder
   frame. A human (or a batch script) runs the queue when the machine is idle.
3. **never** render synchronously inside a round. A card that arrives three rounds late is a good
   outcome; a card that arrives by delaying narration is the failure the whole design avoids.

`kind` is the only taxonomy: `item` 640x640, `location` 832x480, `portrait` 512x768. Nothing in the
game asks for art that is not one of those three, so a restyle is a re-batch rather than a redesign.

## Still to do

- `server.mjs` currently renders live on `art_jobs`. That becomes the resolver above, with live
  rendering behind an explicit flag for the batch pass.
- `style` belongs in the manifest and in the filename prefix, so a rejected style is one clean
  re-batch instead of a hunt through the ComfyUI output folder.
