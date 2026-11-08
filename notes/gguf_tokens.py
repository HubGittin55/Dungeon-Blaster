#!/usr/bin/env python3
"""Bytes-that-must-move-per-decoded-token, from the GGUF header alone.

Decode speed on this box is memory-bound, so tok/s = effective bandwidth / bytes-per-token. Two
traps make hand-waving about "4-bit vs 4-bit" meaningless:

  1. The file name only describes the ROUTED EXPERTS. What the dense/attention/shared-expert path
     is quantized to dominates, because every token reads all of it, while only 8 of 256 experts
     get touched (so the expert pool costs bytes/32, not bytes/1).
  2. token_embd is a row lookup, not a read. Counting it as per-token traffic overstates the
     arithmetic (it does still count toward residency).

Usage: python gguf_tokens.py <gguf-or-header> [more...]
"""
import json, os, struct, sys, collections

ENUM = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "type_enum.json")))
ENUM = {int(k): v for k, v in ENUM.items()}
BPW = {"F32":32,"F16":16,"BF16":16,"Q4_0":4.50,"Q4_1":4.50,"Q5_0":5.5,"Q5_1":5.5,"Q8_0":8.50,"Q8_1":9,
 # K-quants are exact block ratios, NOT the "_M/_S" marketing numbers people quote: a Q4_K superblock
 # is 144 bytes per 256 weights = 4.5 bpw. Getting these wrong quietly biases every prediction built
 # on them (it made my own IQ4_XS reference 10% too big and the requant prediction 15% too optimistic).
 "Q2_K":3.28125,"Q3_K":3.625,"Q4_K":4.50,"Q5_K":5.50,"Q6_K":6.5625,"Q8_K":8.125,"IQ2_XXS":2.06,
 "IQ2_XS":2.31,"IQ3_XXS":3.06,"IQ1_S":1.56,"IQ4_NL":4.50,"IQ3_S":3.44,"IQ2_S":2.5,"IQ2_M":2.7,
 "IQ3_M":3.44,"IQ4_XS":4.21875,"I8":8,"IQ1_M":1.69,"MXFP4":4.25,"NVFP4":4.5,"Q1_0":1.125,"Q2_0":2.25,
 "F8_E4M3":8}
# classes: EVERY = read whole by every token, ROW = only the rows in context, SPARSE = 8/256,
# DRAFT = only present when the MTP drafter runs
# draft_min: first block index belonging to the drafter. The MTP layer is a full transformer block
# (blk.40.*) whose attention/FFN tensors are NOT named ".nextn." - counting them as per-token traffic
# overstates decode cost, because they only run for the draft token.
def classify(name, draft_min=None):
    n = name.lower()
    if ".nextn." in n:
        return "DRAFT"
    if draft_min is not None:
        head = n.split(".")
        if len(head) > 1 and head[0] == "blk" and head[1].isdigit() and int(head[1]) >= draft_min:
            return "DRAFT"
    if "_exps." in n:
        return "SPARSE"
    if "token_embd" in n:
        return "ROW"
    return "EVERY"


def rd_str(f):
    (n,) = struct.unpack("<Q", f.read(8)); return f.read(n).decode("utf-8", "replace")


def rd(f, t):
    if t == 8: return rd_str(f)
    if t == 9:
        (et,) = struct.unpack("<I", f.read(4)); (n,) = struct.unpack("<Q", f.read(8))
        return [rd(f, et) for _ in range(n)]
    fmt = {0:"<B",1:"<b",2:"<H",3:"<h",4:"<I",5:"<i",6:"<f",7:"<B",10:"<Q",11:"<q",12:"<d"}[t]
    return struct.unpack(fmt, f.read(struct.calcsize(fmt)))[0]


def scan(path):
    with open(path, "rb") as f:
        if f.read(4) != b"GGUF":
            raise SystemExit(f"{path}: not a GGUF header")
        ver, = struct.unpack("<I", f.read(4))
        nten, = struct.unpack("<Q", f.read(8)); nkv, = struct.unpack("<Q", f.read(8))
        meta = {}
        for _ in range(nkv):
            k = rd_str(f); (t,) = struct.unpack("<I", f.read(4)); meta[k] = rd(f, t)
        rows = []
        while len(rows) < nten:
            try:
                name = rd_str(f); (nd,) = struct.unpack("<I", f.read(4))
                dims = [struct.unpack("<Q", f.read(8))[0] for _ in range(nd)]
                (qt,) = struct.unpack("<I", f.read(4)); struct.unpack("<Q", f.read(8))
                rows.append((name, dims, qt))
            except Exception:
                break     # ranged fetch ran out; partial tally is still valid for the big tensors
    return meta, nten, rows


def main():
    paths = sys.argv[1:] or ["head.bin"]
    out = {}
    for path in paths:
        meta, nten, rows = scan(path)
        ec = meta.get("general.architecture", "?")
        nexp = meta.get(f"{ec}.expert_count") or 256
        nuse = meta.get(f"{ec}.expert_used_count") or 8
        # the drafter owns the top block(s): block_count is the real layer count
        nlayer = meta.get(f"{ec}.block_count")
        nextn = meta.get(f"{ec}.nextn_predict_layers") or 0
        draft_min = (nlayer - nextn) if (nlayer and nextn) else None
        cls = collections.Counter(); bpw_by = collections.defaultdict(collections.Counter)
        total = 0.0
        for name, dims, qt in rows:
            tn = ENUM.get(qt, f"?{qt}"); n = 1
            for d in dims: n *= d
            c = classify(name, draft_min)
            cls[c] += n; bpw_by[c][tn] += n
            total += n * BPW.get(tn, 8.0) / 8.0
        frac = nuse / nexp
        per_tok = (cls["EVERY"] * 8.5 / 8)  # placeholder, recomputed below with real bpw
        per_tok = sum(p * BPW.get(t, 8.0) / 8 for t, p in bpw_by["EVERY"].items()) \
                + sum(p * BPW.get(t, 8.0) / 8 for t, p in bpw_by["SPARSE"].items()) * frac
        mtp = sum(p * BPW.get(t, 8.0) / 8 for t, p in bpw_by["DRAFT"].items())
        print(f"\n=== {os.path.basename(path)}")
        print(f"  tensors {len(rows)}/{nten}   file {total/2**30:6.2f} GiB on disk   experts {nexp} pick {nuse}"
              + (f"   draft layers >= blk.{draft_min}" if draft_min else ""))
        for c in ("EVERY", "SPARSE", "ROW", "DRAFT"):
            if not cls[c]:
                continue
            b = sum(p * BPW.get(t, 8.0) / 8 for t, p in bpw_by[c].items())
            mix = ", ".join(f"{t}:{p/1e9:.2f}B" for t, p in bpw_by[c].most_common())
            print(f"  {c:6s} {cls[c]/1e9:6.2f} B params  {b/2**30:6.2f} GiB  [{mix}]")
        print(f"  -> bytes/token = EVERY + SPARSE*{nuse}/{nexp} = {per_tok/2**30:.2f} GiB"
              f"   (MTP draft pass adds {mtp/2**30:.2f} GiB if it runs)")
        for bw in (40, 46, 52):
            print(f"     at {bw} GB/s: {bw/(per_tok/2**30):5.1f} tok/s", end="")
        print()
        out[path] = per_tok
    if len(out) == 2:
        a, b = list(out.values())
        print(f"\n  ratio: {os.path.basename(paths[0])} / {os.path.basename(paths[1])} = {a/b:.2f}x bytes/token"
              f"  -> expect the smaller file to be {a/b:.2f}x faster if truly bandwidth-bound")


if __name__ == "__main__":
    main()
