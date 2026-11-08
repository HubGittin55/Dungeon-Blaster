#!/usr/bin/env python3
"""Tally a GGUF's quantization map from the header only - works on a ranged HTTP fetch.

Why this exists: the file name advertises one quant ("MXFP4", "IQ4_XS") and tells you nothing about
what the dense layers, embeddings and MTP block actually are. On CPU, bytes-moved-per-token is what
sets decode speed, and for a sparse MoE that number is dominated by the *dense* path, because every
token reads all of it while only ~8/256 experts get touched. So the honest question is not "which
quant" but "which bytes".

Usage: python gguf_quants.py <gguf-or-header-dump> [--full]
"""
import struct, sys, collections

T_UINT8, T_INT8, T_UINT16, T_INT16, T_UINT32, T_INT32, T_FLOAT32, T_BOOL, T_STRING, T_ARRAY, \
    T_UINT64, T_INT64, T_FLOAT64 = range(13)

# ggml tensor types, in order, with their bits-per-weight (sub-byte types use the block ratio)
TYPES = ["F32", "F16", "BF16", "Q4_0", "Q4_1", "Q4_1S", "Q5_0", "Q5_1", "Q8_0", "Q8_1", "Q2_K",
         "Q3_K_S", "Q3_K_M", "Q3_K_L", "Q4_K_S", "Q4_K_M", "Q5_K_S", "Q5_K_M", "Q6_K", "IQ2_XXS",
         "IQ2_XS", "Q2_K_S", "IQ3_XS", "IQ3_XXS", "IQ1_S", "IQ4_NL", "IQ3_S", "IQ3_M", "IQ2_S",
         "IQ2_M", "Q4_K_S", "IQ1_M", "BF16", "Q8_K", "IQ4_XS", "IQ1_S", "Q5_K_S", "IQ2_XXS", "Q4_K_M",
         "MXFP4"]
BPW = {"F32": 32.0, "F16": 16.0, "BF16": 16.0, "Q4_0": 4.5, "Q8_0": 8.5, "Q6_K": 8.625,
       "Q4_K_S": 4.9, "Q4_K_M": 5.0, "Q5_K_M": 5.7, "IQ4_NL": 4.5, "IQ4_XS": 4.25, "MXFP4": 4.25,
       "Q2_K": 3.4, "Q3_K_M": 4.6, "IQ3_XXS": 3.1, "IQ2_M": 2.7, "Q8_K": 8.0}
DENSE_HINTS = ("attn", "attention", "linear_attn", "conv", "delta", "gate.up", "down", "shared",
               "norm", "embed", "output", "eh_proj", "enorm", "hnorm", "A_log", "dt_bias")


def rd_str(f):
    (n,) = struct.unpack("<Q", f.read(8))
    return f.read(n).decode("utf-8", "replace")


def rd_val(f, t):
    if t == T_STRING:
        return rd_str(f)
    if t == T_ARRAY:
        (et,) = struct.unpack("<I", f.read(4))
        (n,) = struct.unpack("<Q", f.read(8))
        return [rd_val(f, et) for _ in range(n)]
    fmt = {T_UINT8: "<B", T_INT8: "<b", T_UINT16: "<H", T_INT16: "<h", T_UINT32: "<I", T_INT32: "<i",
           T_FLOAT32: "<f", T_BOOL: "<B", T_UINT64: "<Q", T_INT64: "<q", T_FLOAT64: "<d"}[t]
    return struct.unpack(fmt, f.read(struct.calcsize(fmt)))[0]


def main():
    path = sys.argv[1]
    with open(path, "rb") as f:
        assert f.read(4) == b"GGUF", "not GGUF"
        (ver,) = struct.unpack("<I", f.read(4))
        (ntensor,) = struct.unpack("<Q", f.read(8))   # GGUF header: n_tensors BEFORE n_kv
        (nkv,) = struct.unpack("<Q", f.read(8))
        meta = {}
        for _ in range(nkv):
            k = rd_str(f)
            (t,) = struct.unpack("<I", f.read(4))
            meta[k] = rd_val(f, t)
        rows = []
        try:
            for _ in range(ntensor):
                name = rd_str(f)
                (nd,) = struct.unpack("<I", f.read(4))
                dims = [struct.unpack("<Q", f.read(8))[0] for _ in range(nd)]
                (qt,) = struct.unpack("<I", f.read(4))
                (off,) = struct.unpack("<Q", f.read(8))
                rows.append((name, dims, qt))
        except Exception:
            print("  (header truncated - ranged fetch; tally covers the tensors that fit)")

    arch = meta.get("general.architecture", "?")
    print(f"{path}\n  arch={arch}  declared_tensors={ntensor}  parsed={len(rows)}  gguf v{ver}")
    for k in sorted(meta):
        if any(s in k for s in ("block_count", "expert", "nextn", "full_attention", "context_length",
                                "embedding_length", "head_count", "feed_forward", "key_length", "value_length")):
            print(f"    {k} = {meta[k]}")

    tally = collections.Counter()
    params = collections.Counter()
    dense_bytes = experts_bytes = 0.0
    for name, dims, qt in rows:
        qname = TYPES[qt] if qt < len(TYPES) else f"type{qt}"
        n = 1
        for d in dims:
            n *= d
        tally[qname] += 1
        params[qname] += n
        bpw = BPW.get(qname, 8.0)
        nbytes = n * bpw / 8.0
        is_expert = ("blk." in name and ".ffn." in name and "shared" not in name)
        if is_expert:
            experts_bytes += nbytes
        else:
            dense_bytes += nbytes

    print("\n  quant            tensors        params")
    for q, c in tally.most_common():
        print(f"  {q:16s} {c:8d} {params[q]:14,.0f}")
    total = dense_bytes + experts_bytes
    print(f"\n  dense/every-token bytes    = {dense_bytes/2**30:6.2f} GiB   <- read by EVERY token")
    print(f"  expert bytes (all)         = {experts_bytes/2**30:6.2f} GiB   <- 8 of 256 per token")
    print(f"  per-token floor            = {dense_bytes/2**30 + experts_bytes/2**30*8/256:6.2f} GiB"
          f"  ({(dense_bytes + experts_bytes*8/256)*8/35.51e9:.2f} GB/token at 35.5B params)")
    print(f"  at 28 GB/s: {28.0/((dense_bytes + experts_bytes*8/256)/2**30):.1f} tok/s theoretical ceiling")


if __name__ == "__main__":
    main()
