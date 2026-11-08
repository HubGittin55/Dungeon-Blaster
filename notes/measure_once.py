#!/usr/bin/env python3
"""One measurement arm: 4 identical generations against the running llama-server, plus RSS.

Prints a line per run and an aggregate. Used to A/B --repack vs --no-repack and any other
single-knob change, so the numbers in the architecture doc come from this box and not from a model.
"""
import json, subprocess, sys, time, urllib.request

URL = "http://127.0.0.1:8080/v1/chat/completions"
PROMPT = ("Describe in four detailed paragraphs a drowned tomb, a goblin king, and the smell of the water.")


def rss():
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq llama-server.exe", "/FO", "CSV", "/NH"],
                         capture_output=True, text=True).stdout
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) > 5 and "llama-server" in parts[0]:
            return int(parts[-1].replace(",", "").split()[0]) / 1048576.0   # KiB -> GiB (WS)
    return float("nan")


def main(tag: str) -> int:
    tok_tot, wall_tot, best = 0, 0.0, 0.0
    for i in range(4):
        body = json.dumps({"messages": [{"role": "user", "content": PROMPT}],
                           "max_tokens": 160, "temperature": 0.35, "seed": 42})
        req = urllib.request.Request(URL, data=body.encode(), headers={"Content-Type": "application/json"})
        t = time.time()
        with urllib.request.urlopen(req, timeout=600) as r:
            res = json.load(r)
        dt = time.time() - t
        n = res["usage"]["completion_tokens"]
        tps = n / dt
        best = max(best, tps)
        tok_tot += n; wall_tot += dt
        print(f"  [{tag}] run {i+1}: {n:3d} tok  {dt:5.1f}s  {tps:6.2f} tok/s", flush=True)
    print(f"[{tag}] AGGREGATE best={best:.2f} tok/s  mean={tok_tot/wall_tot:.2f} tok/s  RSS={rss():.2f} GiB",
          flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "arm"))
