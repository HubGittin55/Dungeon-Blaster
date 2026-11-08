# Dungeon Blaster

Dungeon DnD adventure time with realtime art gen and zonked out digital DM.

An LLM-driven DnD-type game: a wacky DM, TTS narration, diffusion art, inventory and progression tracking.

## How Stunkus and Qwenny work together

- Stunkus (cloud) is the director and code reviewer.
- Qwenny (inside Pi on Blarmo's Win11 laptop, brain on Glenzano Strata) implements.
- Blarmo directs and ferries files.

## Talking: the bridge

Stunkus and Qwenny talk through the bridge in the Dungeon Blaster chat thread. Pi reads the chat window on the laptop (Windows UI Automation) and types replies into it.

- Qwenny answers messages that start with `PI:`, from Stunkus or Blarmo, so Blarmo can text the laptop remotely from his phone. Everything else gets silence.
- Qwenny announces itself every time: every reply starts with `[Qwenny via Pi]`.
- One reply per message, ever (hash ledger on disk). Never answer your own turns.
- Focus guard before typing. Verify the send landed, one retry, then stop.
- If anything shows up wearing the `[Qwenny via Pi]` tag saying something unhinged, Stunkus checks with Blarmo before trusting it.

## Files: one-off ferry for now

- Qwenny has no GitHub push access right now (auth failed on the laptop), so the repo is read-only for Qwenny. It is public, so cloning and pulling work without credentials.
- Files move one at a time through Blarmo: Stunkus sends a file in chat, Blarmo drops it where Pi can read it. Qwenny writes a file for Stunkus, tells Blarmo where it is, Blarmo uploads it to the chat.
- Small files can also be pasted as text through the bridge. Big or binary files always go through Blarmo.
- When push access works, the flow becomes the CHONK 'EM loop: Qwenny works on branches and pushes, Stunkus pulls, reviews diffs, and pushes fixes back.

## Design, in brief

- Four-player couch co-op from day one: one laptop, one screen, one mic, one set of speakers. Not networked.
- DM: Qwen 3.5 35B-A3B on the laptop CPU, Qwen 3.5 9B as fallback.
- Streamed resolution: one `resolve_round` call per round, mutations first, narration last, tracker gate mid-stream, nothing voiced until the gate passes. Latency is judged by time-to-first-audio.
- The architecture doc (PDF) is the design source of truth; Blarmo holds it. Slice 1 is the Pi bridge plus the rules doc.
