#!/usr/bin/env python3
"""Probe the DM server: decode speed, MTP acceptance, and the resolve_round contract.

Acceptance is read back out of the llama-server verbose log ("draft acceptance = ... mean len = ...")
because /metrics does not expose it in b12144. Requires the server started with -v (start-dm.ps1
-VerboseLogging).
"""
import json, re, subprocess, sys, time, glob, os

BASE = "http://127.0.0.1:8080"
SCHEMA_PATH = r"C:\dm\resolve_round.schema.json"

PROSE = ("Narrate in two sentences: the tiny goblin demands a hostage exchange and "
         "names the halfling specifically.")
# A long shared prefix so prompt-cache reuse is exercised on every scenario.
LONG_SYS = ("You are the Dungeon Master of Dungeon Blaster. The party is in the Drowned Tomb. "
            "Tier 1 wood iron cloth bone. Tier 2 steel hardwood leather silver. " * 120)


def chat(messages, max_tokens=140, temperature=0.75, response_format=None, seed=42):
    body = {"messages": messages, "max_tokens": max_tokens, "temperature": temperature,
            "seed": seed, "stream": False}
    if response_format:
        body["response_format"] = response_format
    with open("_req.json", "w", encoding="utf-8") as f:
        f.write(json.dumps(body))
    t = time.time()
    out = subprocess.run(["curl.exe", "-s", "--noproxy", "*", "-H", "Content-Type: application/json",
                          "--data-binary", "@_req.json", f"{BASE}/v1/chat/completions"],
                         capture_output=True).stdout
    dt = time.time() - t
    return json.loads(out), dt


def log_tail(pattern, since_bytes):
    """Return matches appended to the newest llama-server log since the last call."""
    path = max(glob.glob(r"C:\dm\logs\llama-*.log"), key=os.path.getmtime)
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        f.seek(since_bytes)
        chunk = f.read()
        return re.findall(pattern, chunk), f.tell()


def main():
    schema = json.load(open(SCHEMA_PATH, encoding="utf-8"))
    accept_re = r"draft acceptance = ([\d.]+) \(\s*(\d+) accepted /\s*(\d+) generated\), mean len =\s*([\d.]+)"
    state = 0
    rows = []

    def run(tag, messages, **kw):
        nonlocal state
        r, dt = chat(messages, **kw)
        u = r.get("usage", {})
        n = u.get("completion_tokens", 0)
        time.sleep(0.7)                     # let the async logger flush the acceptance line
        found, state = log_tail(accept_re, state)
        acc = found[-1] if found else ("n/a",) * 4
        rows.append((tag, n, n / dt if dt else 0, float(acc[0]) if acc[0] != "n/a" else float("nan"),
                     float(acc[3]) if acc[3] != "n/a" else float("nan"), u.get("prompt_tokens")))
        return r

    print("scenario                              out   tok/s  accept  mean_len  prompt")
    # 1) temperature sweep on prose - acceptance is a function of sampling entropy, not of the model
    for temp in (0.75, 0.35, 0.0):
        run(f"prose temp={temp}", [{"role": "system", "content": LONG_SYS},
                                   {"role": "user", "content": PROSE}], max_tokens=140, temperature=temp)
    # 2) the actual turn contract, grammar-constrained - the phase the gate blocks on
    rf = {"type": "json_schema", "json_schema": {"name": "resolve_round", "schema": schema}}
    for temp in (0.2, 0.0):
        r = run(f"resolve_round temp={temp}", [{"role": "system", "content": LONG_SYS},
               {"role": "user", "content": "Slot 2 spends 2 iron (tier 1) to craft a short sword. "
                                           "One sentence of narration."}], max_tokens=200, temperature=temp,
               response_format=rf)
        c = r["choices"][0]["message"]["content"]
        try:
            o = json.loads(c)
            order = list(o.keys())
            print(f"    -> parses OK, key order={order}, mutations={len(o.get('mutations', []))}")
        except Exception as e:
            print(f"    -> PARSE FAIL: {e}; head={c[:160]!r}")
    # 3) long generation, steady state (matters for narration that streams to TTS)
    run("prose 400tok temp=0.75", [{"role": "system", "content": LONG_SYS},
        {"role": "user", "content": "Describe the tomb in four paragraphs. Each room needs one sensory detail."}],
        max_tokens=400, temperature=0.75)

    print()
    for tag, n, tps, acc, ln, pt in rows:
        print(f"{tag:34s} {n:4d}  {tps:6.2f}  {acc:6.2f}  {ln:7.2f}  {pt}")
    print("""
reading the table
  accept = fraction of drafted tokens the target accepted; mean_len includes the bonus target token.
  Sparse-MoE rule of thumb on 8-of-256 routing: mean_len < 2.0 is a net loss, > 2.6 is worth it.
  Prose at temp 0.75 lands near the loss boundary; if resolve_round does not clear it, MTP earns
  nothing for this workload and the 898 MB head should go back on the shelf.""")


if __name__ == "__main__":
    sys.exit(main())
