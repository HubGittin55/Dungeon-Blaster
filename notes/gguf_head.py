"""Parse the GGUF header + metadata (and tensor-info if present) from a partial download."""
import json
import struct
import sys
from collections import Counter

path = sys.argv[1]
f = open(path, "rb")
assert f.read(4) == b"GGUF", "not GGUF"
ver = struct.unpack("<I", f.read(4))[0]
n_tensors = struct.unpack("<Q", f.read(8))[0]
n_kv = struct.unpack("<Q", f.read(8))[0]
print(f"GGUF v{ver}  n_tensors={n_tensors}  n_kv={n_kv}")


def rd(fmt):
    n = struct.calcsize(fmt)
    return struct.unpack(fmt, f.read(n))[0]


def rstr():
    n = rd("<Q")
    return f.read(n).decode("utf-8", "replace")


def rval(t):
    if t == 0:
        return rd("<B")
    if t == 1:
        return rd("<b")
    if t == 2:
        return rd("<H")
    if t == 3:
        return rd("<h")
    if t == 4:
        return rd("<I")
    if t == 5:
        return rd("<i")
    if t == 6:
        return rd("<f")
    if t == 7:
        return rd("<?")
    if t == 8:
        return rstr()
    if t == 10:
        return rd("<Q")
    if t == 11:
        return rd("<q")
    if t == 12:
        return rd("<d")
    if t == 9:
        at = rd("<I")
        n = rd("<Q")
        vals = []
        for i in range(n):
            v = rval(at)
            if n <= 20:
                vals.append(v)
            elif i == 20:
                vals.append(f"<{n} items total>")
        return vals
    raise ValueError(f"unknown type {t}")


meta = {}
for _ in range(n_kv):
    k = rstr()
    t = rd("<I")
    meta[k] = rval(t)

SKIP = ("tokenizer.chat_template", "tokenizer.ggml.tokens", "tokenizer.ggml.scores",
        "tokenizer.ggml.token_type", "tokenizer.ggml.merges", "tokenizer.ggml.byte_fallback",
        "tokenizer.ggml.added_tokens")

print("\n=== METADATA (chat-template/vocab blobs omitted) ===")
for k, v in meta.items():
    if any(k.startswith(s) for s in SKIP):
        print(f"{k} = <{len(str(v))} chars>")
        continue
    print(f"{k} = {str(v)[:300]}")

ct = meta.get("tokenizer.chat_template", "")
print(f"\nchat_template chars={len(ct)}  template_version_line=",
      next((l for l in ct.splitlines() if "template_version" in l), "n/a")[:120])

# ---- tensor info section (may be truncated by the partial download) ----
print("\n=== TENSOR INFO ===")
tensors = []
try:
    for _ in range(n_tensors):
        name = rstr()
        nd = rd("<I")
        dims = [rd("<Q") for _ in range(nd)]
        dt = rd("<I")
        off = rd("<Q")
        tensors.append((name, dims, dt, off))
except Exception as e:
    print("tensor info truncated at", len(tensors), type(e).__name__)

# llama.cpp ggml type ids
TYPES = {0: "f32", 1: "f16", 2: "bf16", 3: "q4_0", 4: "q4_1", 5: "q5_0", 6: "q5_1", 7: "q8_0",
         8: "q2_k", 9: "q3_k", 10: "q4_k", 11: "q5_k", 12: "q6_k", 13: "q8_k", 14: "iq4_nl",
         15: "iq4_xs", 16: "mxfp4", 17: "q8_1", 18: "q5_x_x", 19: "mxfp4_moe", 20: "q3_k_xs"}
print("tensors parsed:", len(tensors))
if tensors:
    print("max offset end (approx data size):", max(t[3] for t in tensors) / 1e9, "GB + payload")
    buckets = Counter()
    for name, dims, dt, off in tensors:
        kind = "ffn_exps" if ".ffn_exps." in name else "attn" if ".attn." in name else \
               "ffn_" if ".ffn_" in name else "attn_kv" if "attn_kv" in name else \
               "mtp" if name.startswith("mtp") or "blk.4" in name and False else "other"
        buckets[(kind, TYPES.get(dt, f"type{dt}"))] += 1
    for k, v in sorted(buckets.items()):
        print(f"  {k[0]:10s} {k[1]:10s} x{v}")
    print("\n--- sample tensor names (non-expert) ---")
    shown = 0
    for name, dims, dt, off in tensors:
        if ".ffn_exps." not in name:
            print(f"  {name} dims={dims} type={TYPES.get(dt, dt)}")
            shown += 1
            if shown > 45:
                break
    print("\n--- MTP-ish tensors ---")
    mtp = [t for t in tensors if "nextn" in t[0] or "mtp" in t[0] or "predict" in t[0]]
    print("count:", len(mtp))
    for t in mtp[:20]:
        print("  ", t[0], t[1], TYPES.get(t[2], t[2]))
    names = [t[0] for t in tensors]
    print("\nmax block index:", max(int(n.split(".")[1]) for n in names if n.startswith("blk.")))
json.dump({k: str(v) for k, v in meta.items()}, open(path + ".meta.json", "w", encoding="utf8"), indent=1)
