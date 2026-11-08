import itertools
import struct
import sys
from collections import defaultdict

BPW = {  # ggml type id -> (name, bits per weight incl. block overhead)
    0: ("f32", 32.0), 1: ("f16", 16.0), 2: ("bf16", 16.0), 3: ("q4_0", 4.5), 4: ("q4_1", 4.56),
    6: ("q5_0", 5.5), 7: ("q5_1", 5.56), 8: ("q8_0", 8.5), 9: ("q8_1", 9.0),
    11: ("q3_k", 3.44), 12: ("q4_k", 4.5), 13: ("q5_k", 6.56), 14: ("q6_k", 5.5),
    16: ("iq2_xxs", 2.06), 17: ("iq2_xs", 2.31), 18: ("iq3_xxs", 3.06), 19: ("iq1_s", 1.56),
    20: ("iq4_nl", 4.5), 21: ("iq3_s", 3.44), 22: ("iq2_s", 2.5), 23: ("iq4_xs", 4.25),
    29: ("iq1_m", 1.75), 30: ("bf16", 16.0), 34: ("tq1_0", 1.69), 35: ("tq2_0", 2.6),
    36: ("mxfp4", 4.5), 39: ("mxfp4?", 4.25),
}
CAND = {3.44, 3.06, 4.25, 4.5, 5.5, 6.56, 8.5, 16.0, 32.0, 2.5, 3.5, 2.31}


def parse(path):
    f = open(path, "rb")
    assert f.read(4) == b"GGUF"
    f.read(4)
    nt = struct.unpack("<Q", f.read(8))[0]
    nkv = struct.unpack("<Q", f.read(8))[0]

    def rd(fmt):
        n = struct.calcsize(fmt)
        return struct.unpack(fmt, f.read(n))[0]

    def rstr():
        n = rd("<Q")
        return f.read(n).decode("utf8", "replace")

    def rval(t):
        m = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?",
             10: "<Q", 11: "<q", 12: "<d"}
        if t in m:
            return rd(m[t])
        if t == 8:
            return rstr()
        if t == 9:
            at = rd("<I")
            n = rd("<Q")
            for _ in range(n):
                rval(at)
        return None

    meta = {}
    for _ in range(nkv):
        k = rstr()
        t = rd("<I")
        meta[k] = rval(t)
    ten = []
    for _ in range(nt):
        name = rstr()
        nd = rd("<I")
        dims = [rd("<Q") for _ in range(nd)]
        dt = rd("<I")
        off = rd("<Q")
        ten.append((name, dims, dt))
    return meta, ten


def classify(name):
    n = name.lower()
    if "token_embd" in n or n.startswith("output"):
        return "embed/output"
    if "shexp" in n:
        return "shared_expert"
    if "_exps." in n or "_exps.weight" in n:
        return "routed_experts"
    if "ssm" in n:
        return "delta_net"
    if "attn" in n:
        return "attention"
    return "norm_bias_other"


for path, size, label in [
    ("head_mtp.bin", 21543974336, "Genesis-Hermes MTP-MXFP4"),
    ("head_IQ4_XS.bin", 1872, "base IQ4_XS"),
    ("head_Q4_K_M.bin", 0, "base Q4_K_M"),
    ("head_IQ4_NL.bin", 0, "base IQ4_NL"),
]:
    meta, ten = parse(path)
    pre = meta.get("general.architecture", "?")
    bc = meta.get(f"{pre}.block_count", "?")
    npl = meta.get(f"{pre}.nextn_predict_layers", "-")
    elems = defaultdict(int)
    kinds = defaultdict(lambda: defaultdict(int))
    for name, dims, dt in ten:
        n = 1
        for d in dims:
            n *= d
        elems[dt] += n
        kinds[classify(name)][dt] += n
    ids = sorted(elems)
    print(f"\n########## {label}  ({path})")
    print(f"  arch={pre} blocks={bc} nextn_predict_layers={npl} "
          f"ctx={meta.get(pre+'.context_length')} n_kv={meta.get(pre+'.attention.head_count_kv')} "
          f"key_len={meta.get(pre+'.attention.key_length')} full_attn_interval={meta.get(pre+'.full_attention_interval')}")
    print(f"  gguf name={meta.get('general.name')!r} file_type={meta.get('general.file_type')}")
    print("  type histogram:", {f"{i}({BPW.get(i,('?',0)  )[0]})": f"{elems[i]/1e9:.2f}B" for i in ids})
    print("  per-kind:")
    for k, d in kinds.items():
        print(f"    {k:18s}", {f"{i}({BPW.get(i,('?',0))[0]})": f"{v/1e9:.2f}B" for i, v in d.items()})
    # brute-force fit of unknown bpw for the two dominant ids
    dom = [i for i in ids if elems[i] / 1e9 > 0.05]
    fixed = sum(elems[i] * BPW[i][1] for i in ids if i not in dom)
    rest = size - fixed if size else 0
    if len(dom) == 2 and size:
        best = []
        for a, b in itertools.product(sorted(CAND), repeat=2):
            # solve continuous: w1*x + w2*y = rest  -> minimize error over grid
            pass
    if size:
        pred = sum(elems[i] * BPW.get(i, ("?", 4.25))[1] for i in ids) / 8
        print(f"  size check: predicted {pred/1e9:.2f} GB vs actual {size/1e9:.2f} GB "
              f"({100*(pred-size)/size:+.2f}%)")
