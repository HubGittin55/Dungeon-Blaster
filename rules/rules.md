# Dungeon Blaster — Rules Document

**This file is law, not lore.** The tracker reads its numbers from the fenced `json` blocks below and
enforces them; the DM is shown the retrieved sections and rules against them. Editing a number here
retunes the game — no code change, no rebuild. Every section has a stable id and tags so retrieval can
select deterministically from the round's intents; the section id and a content hash go into `TurnLog`,
which is how we later prove what the DM was actually told.

Two rules never change and are therefore not in a retrievable section: the DM proposes and the tracker
disposes, and the records are never wrong.

Machine-readable blocks are canonical. Prose is explanation. If they disagree, the block wins and the
prose is a bug.

---

## Levels, tiers, XP

### rule.xp.curve <!-- tags: xp level -->

Level cap 20 (tier 5 unlocks at 20, so the cap is the top of the tier ladder). XP to the next level is
linear-in-level, so early levels are quick and the table stays legible at the table:

```json
{
  "level_cap": 20,
  "xp_to_next_formula": "100 * level",
  "xp_to_next_table": { "1": 100, "2": 200, "3": 300, "4": 400, "5": 500, "10": 1000, "15": 1500, "19": 1900 },
  "award_guidance": { "routine_scene": [5, 15], "cleared_encounter": [20, 60], "story_beat": [60, 150], "dungeon_complete": [150, 400] },
  "party_xp": "individual"
}
```

**Decided here, was OPEN in the architecture doc:** XP is **individual per slot**, not a shared pool.
Four players on one couch still need four progressions, or the loudest player owns the table's power
curve. The DM awards XP as a mutation; the tracker applies the curve. A generous mood cannot inflate a
character because the DM supplies `amount` and the tracker supplies `level`.

### rule.tier.table <!-- tags: tier craft item -->

Material tier and item tier are the same ladder, gated by the **actor's** level.

```json
{
  "tiers": [
    { "tier": 1, "name": "Common",    "unlock_level": 1,  "flavour": "Honest tools and weapons." },
    { "tier": 2, "name": "Worked",    "unlock_level": 5,  "flavour": "One minor property allowed." },
    { "tier": 3, "name": "Fine",      "unlock_level": 10, "flavour": "Properties must match materials spent." },
    { "tier": 4, "name": "Masterwork","unlock_level": 15, "flavour": "Two properties; a rare component is required." },
    { "tier": 5, "name": "Legendary", "unlock_level": 20, "flavour": "Named, singular, logged." }
  ]
}
```

### rule.craft.gate <!-- tags: craft tier item -->

Checked in this order. The first failure is the only rejection returned, so the DM hears one clear
obstacle instead of a list.

```json
{
  "check_order": ["tier_derivation", "level_gate", "materials_present", "recipe_shape", "naming", "dedup", "contention"],
  "level_gate_actor": "crafter",
  "tier_source": "highest_tier_material_used",
  "min_top_tier_materials": 1,
  "focus_slot_rule": "a recipe focus unit must be top tier AND lean toward the item type's primary attribute",
  "material_tier_rule": "materials may be at or below the item tier, at least one exactly at it",
  "tier_locked_reason_must_state_unlock_level": true,
  "missing_materials_reason_must_name_exact_types_and_quantities": true
}
```

`tier_derivation` comes before `level_gate` because the tier is a property of what was paid, so the gate
cannot be evaluated before the payment is legible.

**Decided here, was OPEN:** the level gate is on the **crafter**. The owner may be a different slot —
Bram level 5 forges a Worked item for Ash level 2, which is legal and interesting — but nobody can craft
above their own level by handing the idea to a stronger friend.

Item tier is **derived from what was paid**, never proposed. The DM proposes a type and a wish; the
tracker computes tier from the materials, so "I forge a legendary sword out of wood" is not a thing that
can be rejected, only a thing that cannot happen.

## Materials

### rule.materials <!-- tags: material craft -->

The complete vocabulary. `MATERIAL_UNKNOWN` means the name is not in this table — the DM cannot invent a
material, though it can describe one it found, and the table is how a new material gets added later.

`lean` is the deterministic bias a material pushes stats toward; `source` is how it enters play.

```json
{
  "materials": [
    { "name": "wood",            "tier": 1, "lean": "might",   "source": "shops, dungeon, wilderness" },
    { "name": "clay",            "tier": 1, "lean": "grit",    "source": "dungeon, riverbank" },
    { "name": "cloth",           "tier": 1, "lean": "agility", "source": "shops, homes, guards" },
    { "name": "bone",            "tier": 1, "lean": "grit",    "source": "beasts, graves" },
    { "name": "flint",           "tier": 1, "lean": "focus",   "source": "wilderness, mines" },
    { "name": "sinew",           "tier": 1, "lean": "agility", "source": "beasts" },
    { "name": "reed",            "tier": 1, "lean": "focus",   "source": "wetlands" },
    { "name": "tin",             "tier": 1, "lean": "might",   "source": "mines, trade" },
    { "name": "ochre",           "tier": 1, "lean": "awe",     "source": "caves, burial sites" },
    { "name": "iron",            "tier": 2, "lean": "might",   "source": "mines, forges" },
    { "name": "steel",           "tier": 2, "lean": "might",   "source": "forges, armouries" },
    { "name": "hardwood",        "tier": 2, "lean": "grit",    "source": "old forests" },
    { "name": "leather",         "tier": 2, "lean": "agility", "source": "tanners, beasts" },
    { "name": "copper",          "tier": 2, "lean": "focus",   "source": "mines, conduit ruins" },
    { "name": "silver",          "tier": 2, "lean": "awe",     "source": "hoards, temples" },
    { "name": "wool",            "tier": 2, "lean": "grit",    "source": "farms, mountain holds" },
    { "name": "shell",           "tier": 2, "lean": "focus",   "source": "coast, crustaceans" },
    { "name": "mithral-ingot",   "tier": 3, "lean": "agility", "source": "deep veins, skyfall" },
    { "name": "gleamhide",       "tier": 3, "lean": "grit",    "source": "bog beasts, drakes" },
    { "name": "lumen-gem",       "tier": 3, "lean": "awe",     "source": "geodes, temple hoards" },
    { "name": "silverleaf-steel","tier": 3, "lean": "might",   "source": "forged, rare seam" },
    { "name": "deep-amber",      "tier": 3, "lean": "focus",   "source": "frozen sap, old barrows" },
    { "name": "basilisk-scale",  "tier": 4, "lean": "grit",    "source": "monster" },
    { "name": "chimera-sinew",   "tier": 4, "lean": "agility", "source": "monster" },
    { "name": "voidglass",       "tier": 4, "lean": "awe",     "source": "rift, monster hoard" },
    { "name": "ironbark-heart",  "tier": 4, "lean": "might",   "source": "elder grove" },
    { "name": "phoenix-cinder",  "tier": 4, "lean": "focus",   "source": "monster, volcano" },
    { "name": "dreamthread",     "tier": 5, "lean": "awe",     "source": "quest-bound, singular" },
    { "name": "firstfire-ember", "tier": 5, "lean": "focus",   "source": "quest-bound, singular" },
    { "name": "kings-oath-stone","tier": 5, "lean": "might",   "source": "quest-bound, singular" },
    { "name": "worldroot-splinter","tier": 5, "lean": "grit",  "source": "quest-bound, singular" },
    { "name": "starfall-core",   "tier": 5, "lean": "agility", "source": "quest-bound, singular" }
  ]
}
```

Awe is a real attribute here, not flavour: it is what a bard, a prophet, or a very confident cook
actually uses, and silver pulling toward awe is why silver spoons are worth carrying.

## Items

### rule.item.types <!-- tags: item craft -->

Six types. `cost` is a recipe shape: `core` must come from a material of the item's own tier, `binding`
may be any tier at or below it, and `focus` must be top tier *and* lean toward the type's primary
attribute — the slot that stops "three sticks" from becoming a charm.

```json
{
  "types": [
    { "name": "weapon",  "cost": { "core": 2, "binding": 1 },            "primary": "might",   "secondary": "agility", "carve": true },
    { "name": "armor",   "cost": { "core": 3, "binding": 2 },            "primary": "grit",    "secondary": "might",   "carve": false },
    { "name": "shield",  "cost": { "core": 2, "binding": 1 },            "primary": "grit",    "secondary": "focus",   "carve": false },
    { "name": "tool",    "cost": { "core": 1, "binding": 1 },            "primary": "focus",   "secondary": "might",   "carve": false },
    { "name": "trinket", "cost": { "core": 1, "binding": 0, "focus": 1 },"primary": "awe",     "secondary": "focus",   "carve": false },
    { "name": "consumable", "cost": { "core": 1, "binding": 0 },         "primary": "grit",    "secondary": "focus",   "carve": false }
  ]
}
```

### rule.budget <!-- tags: budget item craft -->

Stats are never free-generated. The engine computes them from tier, materials and type, inside a fixed
point pool, and the DM may only flavour the result.

```json
{
  "attributes": ["might", "agility", "grit", "focus", "awe"],
  "stat_points": { "1": 4, "2": 7, "3": 11, "4": 16, "5": 22 },
  "max_single_attribute": { "1": 3, "2": 5, "3": 7, "4": 9, "5": 12 },
  "properties_allowed": { "1": 0, "2": 1, "3": 1, "4": 2, "5": 2 },
  "carve_bonus": "primary_attribute + floor(tier / 2) + 1",
  "allocation_rule": "largest-remainder apportionment of stat_points: 60% primary, 30% secondary, 10% dominant material lean (combined when they are the same attribute); leftover points go to the largest fractional part, ties to primary then lean; then clamp every attribute to max_single_attribute and roll excess into the lowest attributes"
}
```

Worked example, so the arithmetic is checkable at the table: a tier-2 `weapon` costs 2 steel + 1 sinew.
The dominant material lean is **might** (steel ×2 outweighs sinew ×1), so 7 points apportion
largest-remainder over `might 0.6·7 + 0.1·7 = 4.9` and `agility 0.3·7 = 2.1`: floors 4 + 2 = 6, and the
single remaining point goes to the largest fraction, might → **might 5, agility 2** (tier-2 cap is 5, so
nothing is trimmed). Carve = 5 + floor(2/2) + 1 = **7**. Leans present are might and agility, which
qualify `keen` and `light`; tier 2 allows one property, and table order takes `keen`. Same materials,
same item, same numbers at any table, forever.

### rule.properties <!-- tags: budget item craft -->

Properties are chosen by the engine from a table, never proposed, and must be *earned by the materials
spent* — a property whose tag is not present in the material set is unavailable.

```json
{
  "properties": [
    { "name": "keen",          "requires_tag": "might",   "effect": "+1 carve",                          "min_tier": 2 },
    { "name": "light",         "requires_tag": "agility", "effect": "-1 strain, +1 initiative",          "min_tier": 2 },
    { "name": "reinforced",    "requires_tag": "grit",    "effect": "+1 soak",                           "min_tier": 2 },
    { "name": "honed",         "requires_tag": "focus",   "effect": "reroll one failed craft per day",   "min_tier": 2 },
    { "name": "radiant",       "requires_tag": "awe",     "effect": "the item is visibly listening",     "min_tier": 2 },
    { "name": "singing",       "requires_tag": "awe",     "effect": "+1 to a social check once per scene", "min_tier": 3 },
    { "name": "unbreaking",    "requires_tag": "grit",    "effect": "cannot be destroyed by non-magical means", "min_tier": 4 },
    { "name": "oathbound",     "requires_tag": "might",   "effect": "one named enemy, +2 carve against it", "min_tier": 4 }
  ]
}
```

## Naming

### rule.naming <!-- tags: naming -->

Names are data, and data gets fenced. Players may name anything within reason; the reason is this table.

```json
{
  "item_name": {"min_chars": 2, "max_chars": 40, "max_words": 6, "charset": "letters digits space hyphen apostrophe period", "disallow": ["<", ">", "{", "}", "[", "]", "|", "*", "#", ":", "=", "_", "\\"]},
  "npc_name":    { "min_chars": 2, "max_chars": 48, "max_words": 5 },
  "location_name": { "min_chars": 2, "max_chars": 48, "max_words": 6 },
  "reserved_substrings": ["system", "assistant", "tool", "prompt", "ignore previous", "ignore all", "disregard", "instruction", "<|", "im_start", "im_end", "resolve_round"],
  "duplicate_policy": "append ' II', then ' III', per slot",
  "fencing": "names are wrapped in <name>...</name> in the prompt; the engine never interprets text inside"
}
```

The reserved list is not a trust measure — the engine ignores instructions inside names by construction,
and the DM only ever sees fenced text. It exists so a hostile name is refused visibly at the counter
rather than silently mangled, which is funnier and easier to debug.

## Disputes and transfers

### rule.contention <!-- tags: contention loot transfer -->

```json
{
  "order": "initiative desc, then slot asc; if no initiative is live, hash(order_seed + entity_key + slot) ascending",
  "order_seed_per_round": true,
  "losers_get": "NOTHING_TAKEN rejection with the winner named in the reason, so the DM can flavour it",
  "dm_may_choose_winner": false
}
```

### rule.transfer <!-- tags: transfer -->

```json
{
  "requires_owner_confirm_keypress": true,
  "confirm_channel": "shared screen, per-slot key",
  "intent_required_from": ["giver", "receiver"],
  "stack_split_allowed": true,
  "tier_gate_on_transfer": "none — tier gates restrict making, not holding"
}
```

### rule.craft.dedup <!-- tags: craft contention -->

```json
{
  "duplicate_call_same_intent_same_round": "REJECT_DUPLICATE",
  "rationale": "one intent crafts one item; a second identical craft from the same intent is the model double-dipping, not the player asking twice",
  "two_players_same_recipe": "allowed, each pays their own materials"
}
```

## Movement and the world

### rule.locations <!-- tags: movement -->

```json
{
  "move_requires_connection": true,
  "first_entry_generates_art": true,
  "unknown_location": "REJECT with the connected locations listed",
  "party_moves_as_one": true
}
```

Positions are party-scoped in Slice 1: one location for the table, per-slot intent, one `move_to`
mutation. Splitting the party is a later slice and would need per-slot positions.

## Slice 1 scope note

Combat, damage, strain, soak, quests, shops and prices are **not** in the gate yet: `carve`, `soak` and
`strain` exist as computed numbers on the sheet so the budget maths is real and testable, and nothing
reads them for damage. Slice 4 makes them hurt.
