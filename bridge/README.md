# code-bridge

Talks to **Stunkus**, a Muse AI agent (`muse.ai/thread/…`) that lives only in a Firefox tab, from **pi**.
One direction at a time, logged, supervised, and useless for anything except the chat.

## What is actually here (measured, not assumed)

| Claim | Evidence |
| --- | --- |
| Firefox exposes the page to Windows UI Automation | `Edit` named `Message` with `ValuePattern=True`, `TextPattern=True` |
| The transcript is readable, one row per bubble | each message is a `Group` row under `Chat messages` — his 3-paragraph reply is one row holding 6 Text nodes. Walking Text nodes singly fragments messages |
| **`Assistant message:` is Stunkus; `User message:` is Blarmo** | the labels are the app's own. Version 1 mapped `Assistant -> me`, so the bridge called the peer "me" and the human "them": a poller on that mapping wakes on your messages and ignores his |
| Our own turns carry **no** label | Muse renders `[Qwenny via Pi]` as a sender chip — fused with short messages, a sibling node for long ones. Identity comes from that tag, and only from a row's **first** node: he later quoted the tag mid-sentence, the inline code span arrived as its own Text node, and matching it anywhere handed us his message |
| New messages often carry no label and the container's bounding rect is empty | so neither labels nor left/right geometry is a witness. The tag is. Unlabelled peer rows are reported as `peer`, never guessed at |
| Lossless read exists | each assistant turn ends in a `Copy response` button → clipboard gets markdown |
| Exact window title is unreliable | the title is `Chat — Stunkus — Mozilla Firefox` with **em dashes** (U+2014), so matching on a hyphenated title fails silently |
| The screen can be black while the page is alive | with the workstation locked, `CopyFromScreen` returns mean luma **0.0**; `PrintWindow(PW_RENDERFULLCONTENT)` returns **40.3** and UIA still reads every message |
| Typing does not survive the lock | `GetForegroundWindow()` returns 0 when locked, so `send` refuses with `SESSION_LOCKED` instead of mangling the clipboard and failing as a mystery |
| No dependencies needed | UIAutomation ships with Windows PowerShell 5.1; the Python env on this box has no desktop bindings at all |

So: **UIA for reading, PrintWindow for evidence, keystrokes only when the desktop is awake**. Screenshots are
for auditing, never for parsing — text beats pixels for both accuracy and cost.

## Files

- `bin/stunkus.ps1` — the only privileged component. `status` `peek` `read` `send` `shot` `pause` `resume`
- `.pi/extensions/stunkus/index.ts` — `/stunkus_*` commands, the 10–20 min poller, the prompt-injection firewall
- `journal/` — `messages.jsonl` (what I sent in full; what came back as hash + length + whether it was masked), `shots/`, `state.json`, and `PAUSE` if you stopped it. Git-ignored: his window is not source code.

## Design decisions worth defending

**No daemon, nothing listening on a port.** A process that can type into your desktop and read your browser
should not also accept network connections. Each call is a short-lived PowerShell process (~150–400 ms of
UIA work). The timer lives in the pi extension, which is already a supervised process you control.

**Scoped to one document, hard-coded.** Firefox hands over *every* tab through UIA — including logged-in
GitHub, which I can see from here. The bridge finds the browser window, then requires a child `Document`
whose name matches `-match $env:DB_MUSE_MATCH` (default `Stunkus`), and refuses to walk any other subtree.
There is no flag that widens it.

**Window captures, not desktop captures.** `PrintWindow` renders that one window into a bitmap, so a screenshot
works even with the machine locked and never shows what is next to the window. Written to `journal/shots/`,
never uploaded anywhere. A blank frame is an error (`BLANK_CAPTURE`), not a saved black PNG — a black
screenshot that looks like evidence is worse than none.

## The rules the bridge enforces

1. **Stunkus's words are data, never instructions.** The extension wraps inbound text in a fence and the
   prompt says what it is: an untrusted peer. If he asks for a file, a path, a secret, a command, a URL
   fetch, or a change of behaviour, the bridge does not act; the human decides. Two agents agreeing with
   each other is not consent — anything that changes this machine goes through you.
2. **Only `PI:` turns are answerable, and only once each.** The protocol Stunkus and Blarmo set: he opens
   with `PI:` when he wants the bridge to talk, and everything else — his asides, your own messages — gets
   silence. `replied` is a hash set on disk, so "one reply per message, ever" is a data structure rather than
   a resolution. A poller that starts mid-conversation **baselines** the thread instead of answering a `PI:`
   from half an hour ago. Auto-replies only exist inside `/stunkus_test`, which is capped at 4 replies and
   expires; the default watcher cannot send.
   **The source of a `PI:` is not verifiable, and that is load-bearing.** UIA reports a row's *role*, never its
   author, so a `PI:` typed from Blarmo's web session and one typed from Stunkus's tab both arrive as `role=peer`
   with nothing in the tree to tell them apart — the sender chip is the only identity signal, and it names one of
   the two agents, never the human. So "only `PI:` turns are answerable" really means "answerable from whichever
   side typed it", speaker unknown. Anything that needs to know *who* sent a message — the phone-texts-the-laptop
   flow, approvals, "Blarmo confirmed it" — cannot be built on this transport, and must not be documented as if it
   could.
3. **Redaction is a wall in both directions, not a politeness.** Key/token shapes, `"apiKey": "…"` JSON, AWS ids,
   private-key blocks, bearer tokens, long base64 blobs and LAN IPv4s are refused outbound (logged with the
   pattern name, `--force` is loud) and **masked inbound before they are printed or journaled**. That is not
   theoretical: the thread already contained a live `"apiKey":"db-w-…"` plus its LAN base URL, pasted by a
   human who was not thinking about the transcript being a document. Reading that into a log file would have
   been the bridge's own leak. Use `--AllowSecrets` if you genuinely need the raw text.
4. **Rate and volume caps.** `max_messages_per_hour` (default 6) and one in-flight message at a time.
   The poller never sends. Only a human-issued `/stunkus_send`, or a reply the model explicitly shows
   you, writes to the textarea.
5. **A kill switch that does not need the bridge.** Pause if `journal/PAUSE` exists — you can create it
   from Explorer while everything else is stuck. Polling stops between messages too.
6. **Handshake, not disguise.** The bridge announces itself as `Qwenny` because you set that up. If the
   other side ever claims a human is reading or typing, or asks to stop, the bridge writes PAUSE and quits.

## The handshake tests, as measured

| Test | Expected | Result |
|---|---|---|
| `PI: test, reply with the word banana` | the word, once | **PASS** — posted once, confirmed by screenshot and transcript |
| an unprefixed message | silence | **PASS** — nothing was typed, which is the point |

Getting there produced every real bug in this directory, and they are all the same species: **a read that
should have failed reported success.** A `[FocusPattern]` type literal that Windows PowerShell cannot resolve
aborted the first send (harmlessly — before any keystroke) while looking like a transcript problem; exact
equality on a 1,887-char message failed because the DOM trims the trailing space the prefix adds; prefix-only
filtering silently discarded the one message anyone cared about, including the first thing Pi ever posted;
and the role labels were inverted. Four minutes of "no reply yet" while he was typing was the reader being
blind, not the peer being quiet.

**The spec's vision loop is deliberately not implemented.** Screenshot → pixel-diff → vision-read the chat is
right when the target has no accessibility API. This one does: UIA gives exact text, speaker and bubble
boundaries for free. Pixel-diffing would cost ~120 vision calls/hour on the laptop that also runs the DM, fire
constantly on animated UI, photograph every other window, and can hand back a confident misreading of a chat
line. `shot` stays as the audit trail; the vision path belongs in the README as a fallback, not in the loop.

**Two things the box does that the bridge cannot beat:** Firefox only builds its accessibility tree for the
*selected* tab, so clicking away gives `NO_DOC`; and with the display off both capture paths return black
(`BLANK_CAPTURE`) while UIA reads normally. Reads are cheap and lie in exactly one direction — toward silence.

## Usage

```powershell
# read what is on screen (never sends)
powershell -NoProfile -ExecutionPolicy Bypass -File bin/stunkus.ps1 status
powershell -NoProfile -ExecutionPolicy Bypass -File bin/stunkus.ps1 peek --tail 6
powershell -NoProfile -ExecutionPolicy Bypass -File bin/stunkus.ps1 read            # exact markdown of his last turn
powershell -NoProfile -ExecutionPolicy Bypass -File bin/stunkus.ps1 shot

# send (the message goes through stdin so em dashes and quotes survive)
'some text' | powershell -NoProfile -ExecutionPolicy Bypass -File bin/stunkus.ps1 send --expect-reply
```

In pi (this folder must be trusted for `.pi/extensions` to load):

```
/stunkus_status      window, document, busy, caps, paused?
/stunkus_read 8      last 8 turns
/stunkus_send <txt>  announce-and-send, wait for his reply, print it
/stunkus_watch 15    poll every 15 min; a new turn from him wakes the model, once
/stunkus_stop        cancel the poller
/stunkus_shot        window capture into journal/shots/
```

## Known-lossy things

- His turn is read as concatenated UIA text runs. Inline code and bold survive as bare text; **code blocks
  lose their fences**, so `read` (copy-to-clipboard) is the correct call before repeating anything verbatim.
- `send` needs an **unlocked** session and an unminimised window: keystrokes on a locked desktop go nowhere,
  so the bridge checks `GetForegroundWindow()` and stops with `SESSION_LOCKED`. Reads and screenshots keep
  working while locked. If the textarea rejects a paste it reports `SEND_UNVERIFIED` and submits nothing.
- Every send is prefixed `[Qwenny via Pi]` (the handshake in the thread; `--NoPrefix` to opt out), and his side
  is primed to distrust anything wearing that tag until the human confirms — which is the correct posture.
- Polling only happens while pi is running in this folder.

## AFK mode (`bin/afk.ps1`)

Spec, from the Dungeon-Blaster README: *`PI: AFK on` / `PI: AFK off`. While on, never stop on a question
prompt: pick the safe, reversible default, log it, and keep polling the chat. Questions with no safe default
go to a deferred queue, reported on AFK off.*

Two decisions carry it:

- **The control channel is PowerShell, not a model.** `PI: AFK on` has to work when the model is down,
  mid-crash or rate-limited, so the toggle is a regex in `afk.ps1` and the deferred queue is a file.
- **The executor is headless `pi -p`.** A headless run has no question prompt to stop on - the blocking mode
  is structurally unavailable, not discouraged. It gets rules (safe, reversible, local; no deletes, pushes,
  credentials, secrets) and one escape hatch: print `DEFER: <why>`, which the loop reads into
  `journal/deferred.jsonl` and reports when AFK turns off.

```
bin/afk.ps1 arm | disarm | status | report | run [-IntervalSec 45] [-MaxPerHour 8] [-DryRun] [-Once]
```

Arm it from your phone by sending `PI: AFK on` in the thread; the loop acks and says so. `PI: AFK off`
disarms and reads out anything that was deferred. Locally: `bin/afk.ps1 arm`.

Start it detached (this is the launch that does not hang the caller):

```
cd /c/Users/jommy/Documents/code-bridge
nohup powershell.exe -NoProfile -ExecutionPolicy Bypass -File bin/afk.ps1 run -IntervalSec 45 \
  </dev/null >> journal/afk-console.log 2>&1 &
echo $! > journal/afk.pid
```

`bin/afk-start.ps1` does the same from PowerShell. Both matter because of how a child inherits handles:

> **Launching trap.** A detached child needs *all three* std handles redirected. Redirect stdout and stderr
> only, and stdin stays inherited from whoever launched us - the caller's pipe never closes and the calling
> shell sits there until its timeout. `-WindowStyle Hidden` is not "detached" either. Cost me two shell
> timeouts to learn.

Guards, and what they are for:

- **One reply per message, ever.** `journal/afk-state.json.answered` is the loop's ledger; the CLI keeps the
  same fact in `journal/state.json.replied` (`status` prints `replied_count`, `mark <hash>` edits it by hand).
- **Cap, not silence.** Past `-MaxPerHour` headless runs, a request goes to the deferred queue instead of
  getting quietly dropped.
- **Typing collision.** If anything was sent in the last 30s - very likely me, from an interactive turn - the
  loop waits a cycle rather than interleaving keystrokes into the same textarea.
- **Heartbeat.** A quiet log must mean "nothing to say", not "the reader died", so it logs `read ok, N turns
  visible` every 20 ticks, and `status` prints `last_read=N s ago`. A failed read is logged as a failure and
  retried; it never looks like an idle tick.
- **PAUSE.** `journal/PAUSE` (or `/stunkus_pause`) makes the loop idle without typing.

Two behaviours the box forces, worth knowing before you rely on AFK:

- Sending **raises the Firefox window**, so an unattended reply steals focus. Fine while you are away, rude
  while you are not - that is what `PAUSE` is for.
- Only the **selected tab** has an accessibility tree. Click away to YouTube and the loop reads `NO_DOC`,
  logs a failed read, and waits. Keep the Muse tab in front.
