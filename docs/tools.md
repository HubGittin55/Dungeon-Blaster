# `resolve_round` — the only door

The DM has exactly one way to change the world or make a sound. Everything else it says is theatre.
This file is the tool contract for the pi GM extension. The architecture document requires it to exist
before Slice 1 is written; if code and this file disagree, the code is wrong.

Status: Slice 1 draft. Open decisions are marked **OPEN**.

## 1. Shape

One `resolve_round` call per round, emitted as a native tool call over llama.cpp's OpenAI-compatible
endpoint (`--jinja`, Hermes template, verified emitting `<tool_call>` JSON that llama.cpp parses into
`tool_calls` — see `spikes/spike_toolcall.py`, 4/4 valid with `tool_choice` auto *and* `required`).

```jsonc
{
  "narration": "...",     // FIRST in emission order
  "mutations": [
    { "id": "m1", "tool": "craft_item",   "actor": 2, "intent": "i2", "args": { } },
    { "id": "m2", "tool": "move_to", "actor": null,                    "args": { } }
  ]
}
```

`actor: null` means world/party-scoped and needs no intent. Any mutation touching a slot's inventory or
stats must cite an `intent` id issued by **that slot this round**. Anything else is rejected.

### Emission order is narration-first, deliberately

The architecture document specifies mutations-first so the gate can run mid-stream. We measured the
opposite on the target laptop and **chose narration-first** (user decision, 2026-11-08):

| emission order | first audio | round total |
|---|---|---|
| mutations, then narration | 12.41 s | 17.90 s |
| **narration, then mutations** | **5.63 s** | **9.04 s** |

The invariant survives: narration is **buffered**, never streamed to TTS, and is released only after the
gate passes every mutation. "Say it only after it's checked" is enforced by buffering, not by ordering.
What changes is the failure path — a rejected round costs a full extra decode with nothing spoken
(~9 s) instead of aborting mid-stream. If the evil-bot suite (Slice 1) shows a rejection rate above a
few percent, flip `properties` order back in `resolve_round.schema.json`; key order in `properties` *is*
the emission order (`required` does not control it).

## 2. Where the gate lives

Inside the tool's `execute()`, in this order, fail-closed:

1. **Parse/validate** the call shape. Bad JSON or unknown keys → whole round rejected, `BAD_CALL`.
2. **Attribute** each mutation: actor slot exists and is active; cited intent belongs to that slot and
   this round. Violations → `NO_INTENT` / `SLOT_UNKNOWN`. This is the per-actor authority boundary:
   slot 1's prompt can never spend slot 2's materials.
3. **Rules check** against the retrieved rules document: tier gate vs the actor's level, then materials
   (types and quantities, exact names).
4. **Contention**: mutations claiming the same loot/materials across slots resolve in deterministic
   order (initiative, then seeded by round). The seed goes into `TurnLog`. The DM may flavour the result,
   never choose it.
5. **Commit** atomically: deduct materials, compute stats inside the tier budget (the engine computes;
   the DM only flavoured), mint the item record, queue its art. Partial success is never committed
   mid-round.
6. **Release** the narration to TTS in sentence chunks, and only now. `TurnLog` records intents, rules
   section ids + content hash, order seed, tool calls, state diff, narration.

Free text from the model that is not a `resolve_round` call can never mutate state or be spoken. That
includes the model's own `content` field alongside the tool call, and it includes anything a player
typed inside an item name — names are length-limited, stored as data, and fenced as data in the prompt.

## 3. Rejection

Per-mutation payload, ~40 tokens each, returned to the model so it can re-propose:

```jsonc
{ "id": "m1", "code": "MISSING_MATERIAL", "reason": "needs 1 cloth, has 0", "allowed": ["wood:2"] }
```

| code | when |
|---|---|
| `BAD_CALL` | unparseable / unknown keys / schema violation |
| `SLOT_UNKNOWN` | actor is not 1-4 or the slot owes no intent |
| `NO_INTENT` | mutation needs an intent from that slot this round and has none (or cites another slot's) |
| `TIER_LOCKED` | item tier above the actor's level gate; the reason must state the unlock level |
| `MISSING_MATERIAL` | exact missing types/quantities named in `allowed` |
| `MATERIAL_UNKNOWN` | not a material that exists in the rules doc or that slot's inventory |
| `BAD_ARGS` | tool-specific (e.g. `transfer_item` with no owner confirm, `move_to` to a disconnected location) |
| `CONTENTION_LOSER` | deterministic order gave the contested thing to another slot |

Policy: **one retry per round.** If the retry's normalised mutation hash equals the first attempt's, stop
and take the deterministic fallback — the DM stumbles, valid calls commit, rejected ones do not, and a
short canned narration plays in the bark bank. A second failure takes the same fallback. The DM is the
unreliable narrator; the records are never wrong.

## 4. Mutation vocabulary

Slice 1 implements the crafting loop and movement, nothing else. Combat, quests, and shop/price maths are
later slices; the vocabulary is deliberately small so the gate can be exhaustive.

| tool | scope | needs intent | args |
|---|---|---|---|
| `craft_item` | slot | yes | `name`, `item_type`, `tier`, `materials[] {name, qty}`, `description` |
| `take_item` / `drop_item` | slot | yes | `item`, `qty` |
| `transfer_item` | slot→slot | yes (both: actor's intent + owner's confirm keypress on the shared screen) | `item`, `qty`, `to_slot` |
| `move_to` | world | no | `location` |
| `award_xp` | slot or party | no | `slot` (or `party: true`), `amount`, `reason` |
| `introduce_npc` | world | no | `name`, `role`, `portrait: true` (queues art) |

**OPEN (from the architecture doc, still unresolved):** shared party XP vs individual levels; crafting
gate checked on crafter vs owner when they differ; combat batched per initiative cycle vs per actor.

## 5. Not the DM's tools

The DM cannot call anything else. Everything below is dispatched by the pi GM *after* the gate passes,
from committed state, and never appears in the DM's tool list:

- **TTS** — OmniVoice clone on the RTX 4060, 0.34 s per 57-char sentence, `voice` preset per speaker.
- **Art** — ComfyUI template `anima-card-640` (640², 4-8 steps, cfg 1, 1.2-1.9 s), keyed by stable
  entity id, always async: placeholder first, `asset_ready` swaps in.
- **STT/VAD** — audio.cpp CPU server, during `COLLECTING` only.
- **Save/load** — snapshots of tracker state + asset index.

GPU queue priority: TTS > scene backdrop > item art > portraits. Never queue a render immediately before
a line the table is waiting on — the narrator pays ~4.3 s to reclaim VRAM after a render.

## 6. Model identity

Do not write "Qwen3.5-35B-A3B" (the architecture document's planning name) into configs or logs. The
shipping artifact is:

`C:\dm\models\Hermes3.6-35B-A3B-MTP-MXFP4exp-Q4K_S.gguf` — 17.97 GiB, DIY Q4K_S requant of the vendor
MXFP4 build, 20.4 tok/s decode, `--spec-type none`, `--no-repack`, `--reasoning off`, native Windows
llama-server on `:8080`. Qwen3.5-35B-A3B and Qwen3.6-35B-A3B are not interchangeable names.

## 7. Verification status

| claim | status |
|---|---|
| `resolve_round` emitted as a parseable native tool call | **verified 4/4**, auto and `tool_choice: required` |
| narration-before-mutations key order held by the model | **verified 4/4** (and 20/20 in the schema-mode contract test) |
| `response_format: json_object` is *not* sufficient | **verified 0/4** — the model echoes party state instead of answering |
| gate, intent binding, contention, rejection payloads | **not built yet** — that is Slice 1 |
