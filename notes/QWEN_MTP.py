# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  GGUF MTP Transplant — Google Colab single-cell edition                  ║
# ╚══════════════════════════════════════════════════════════════════════════╝

# ── 0. Install dependencies ─────────────────────────────────────────────────
import subprocess, sys

subprocess.check_call([sys.executable, "-m", "pip", "install", "-q",
                       "gguf", "huggingface_hub", "hf_transfer"])

# ── 1. Configuration — only edit this block ─────────────────────────────────
WORKSPACE_DIR = "/content/gguf_workspace"

SOURCE_REPO     = "mudler/Qwen3.6-35B-A3B-APEX-MTP-GGUF"                        # HF repo for MTP/donor model
SOURCE_FILENAME = "Qwen3.6-35B-A3B-APEX-MTP-Balanced.gguf"                      # filename inside SOURCE_REPO

TARGET_REPO     = "LuffyTheFox/Qwen3.6-35B-A3B-Uncensored-Genesis-Hermes-V7-GGUF"  # HF repo for base model
TARGET_FILENAME = "Hermes3.6-35B-A3B-Uncensored-Genesis-V7-APEX.gguf"      # filename inside TARGET_REPO

SOURCE_PATH = f"{WORKSPACE_DIR}/{SOURCE_FILENAME}"
TARGET_PATH = f"{WORKSPACE_DIR}/{TARGET_FILENAME}"

MTP_PATH    = f"{WORKSPACE_DIR}/35B-A3B-MTP.gguf"
OUTPUT_PATH = f"{WORKSPACE_DIR}/Hermes3.6-35B-A3B-Uncensored-Genesis-V7-MTP-APEX.gguf"

# ── 2. Imports ───────────────────────────────────────────────────────────────
import gc
import hashlib
import os
import struct
from pathlib import Path

import huggingface_hub
from google.colab import userdata
from huggingface_hub import hf_hub_download, login
from gguf import GGUFReader, GGUFValueType

# ── 3. Auth — Hugging Face login via Colab secret ────────────────────────────
print("Authenticating with Hugging Face...")
HF_TOKEN = userdata.get("HF_TOKEN")
if not HF_TOKEN:
    raise RuntimeError("HF_TOKEN secret not found in Colab secrets.")
login(token=HF_TOKEN, add_to_git_credential=False)
print("  Logged in to Hugging Face")

# Enable fast transfers
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "1"

Path(WORKSPACE_DIR).mkdir(parents=True, exist_ok=True)

# ── 4. Helper functions ───────────────────────────────────────────────────────

def get_field_value(reader: GGUFReader, key: str):
    field = reader.get_field(key)
    return field.contents() if field else None


def calculate_on_disk_sizes(tensors, file_size):
    n = len(tensors)
    sizes = []
    for i in range(n):
        if i < n - 1:
            sizes.append(tensors[i + 1].data_offset - tensors[i].data_offset)
        else:
            sizes.append(file_size - tensors[i].data_offset)
    return sizes


def write_kv_value(fout, kv_type, value):
    if kv_type == GGUFValueType.STRING:
        b = value.encode("utf-8")
        fout.write(struct.pack("<Q", len(b))); fout.write(b)
    elif kv_type in (GGUFValueType.UINT8, GGUFValueType.INT8, GGUFValueType.BOOL):
        fout.write(struct.pack("<B", value))
    elif kv_type in (GGUFValueType.UINT16, GGUFValueType.INT16):
        fout.write(struct.pack("<H", value))
    elif kv_type in (GGUFValueType.UINT32, GGUFValueType.INT32):
        fout.write(struct.pack("<I", value))
    elif kv_type == GGUFValueType.FLOAT32:
        fout.write(struct.pack("<f", value))
    elif kv_type in (GGUFValueType.UINT64, GGUFValueType.INT64):
        fout.write(struct.pack("<Q", value))
    elif kv_type == GGUFValueType.FLOAT64:
        fout.write(struct.pack("<d", value))


def write_array_value(fout, sub_type, arr):
    fout.write(struct.pack("<I", int(sub_type)))
    fout.write(struct.pack("<Q", len(arr)))
    for elem in arr:
        if sub_type == GGUFValueType.STRING:
            b = elem.encode("utf-8")
            fout.write(struct.pack("<Q", len(b))); fout.write(b)
        elif sub_type in (GGUFValueType.UINT8, GGUFValueType.INT8, GGUFValueType.BOOL):
            fout.write(struct.pack("<B", elem))
        elif sub_type in (GGUFValueType.UINT16, GGUFValueType.INT16):
            fout.write(struct.pack("<H", elem))
        elif sub_type in (GGUFValueType.UINT32, GGUFValueType.INT32):
            fout.write(struct.pack("<I", elem))
        elif sub_type == GGUFValueType.FLOAT32:
            fout.write(struct.pack("<f", elem))
        elif sub_type in (GGUFValueType.UINT64, GGUFValueType.INT64):
            fout.write(struct.pack("<Q", elem))
        elif sub_type == GGUFValueType.FLOAT64:
            fout.write(struct.pack("<d", elem))


def _abort(msg):
    raise RuntimeError(f"\n❌  {msg}")


def download_model(repo_id: str, filename: str, local_path: str, token: str):
    """Download a single GGUF file from HF into local_path using hf_transfer."""
    print(f"  Downloading {filename} from {repo_id} ...")
    hf_hub_download(
        repo_id=repo_id,
        filename=filename,
        local_dir=str(Path(local_path).parent),
        token=token,
    )
    print(f"  ✅  Saved to {local_path}")


def extract_mtp_tensors(source_path: str, mtp_path: str, alignment: int = 32):
    """
    Read source_path, identify all Multi-Token Prediction tensors
    (blk.N.* where N >= source_block_count - nextn_predict_layers),
    and write them into a self-contained minimal GGUF at mtp_path.
    """
    print(f"\nExtracting MTP tensors from: {source_path}")
    reader     = GGUFReader(source_path)
    file_size  = Path(source_path).stat().st_size

    arch       = get_field_value(reader, "general.architecture")
    if arch is None:
        _abort("Source GGUF has no general.architecture key")

    blk_count  = get_field_value(reader, f"{arch}.block_count")
    nextn      = get_field_value(reader, f"{arch}.nextn_predict_layers")
    if nextn is None:
        _abort("Source GGUF has no nextn_predict_layers key")

    mtp_start  = blk_count - nextn                              # first MTP block index
    mtp_tensors = [
        t for t in reader.tensors
        if any(t.name.startswith(f"blk.{i}.") for i in range(mtp_start, blk_count))
    ]

    if not mtp_tensors:
        _abort(f"No MTP tensors found for blocks {mtp_start}..{blk_count - 1} in source")

    print(f"  Arch: {arch}, block_count: {blk_count}, nextn: {nextn}")
    print(f"  MTP block range: blk.{mtp_start} … blk.{blk_count - 1}")
    print(f"  MTP tensors found: {len(mtp_tensors)}")

    on_disk_sizes = calculate_on_disk_sizes(reader.tensors, file_size)
    tensor_size_map = {
        t.name: (t, sz)
        for t, sz in zip(reader.tensors, on_disk_sizes)
    }

    # KVs to embed: general.architecture, block_count, nextn_predict_layers
    kv_pairs = [
        ("general.architecture",         GGUFValueType.STRING, arch),
        (f"{arch}.block_count",          GGUFValueType.UINT32, blk_count),
        (f"{arch}.nextn_predict_layers", GGUFValueType.UINT32, nextn),
    ]
    kv_count    = len(kv_pairs)
    tensor_count = len(mtp_tensors)

    with open(source_path, "rb") as fin, open(mtp_path, "wb") as fout:
        # Header
        fout.write(b"GGUF")
        fout.write(struct.pack("<I", 3))
        fout.write(struct.pack("<Q", tensor_count))
        fout.write(struct.pack("<Q", kv_count))

        # KVs
        for key, kv_type, value in kv_pairs:
            kb = key.encode("utf-8")
            fout.write(struct.pack("<Q", len(kb))); fout.write(kb)
            fout.write(struct.pack("<I", int(kv_type)))
            write_kv_value(fout, kv_type, value)

        # Tensor info — compute relative offsets first
        current_offset = 0
        tensor_offsets = []
        for t in mtp_tensors:
            tensor_offsets.append(current_offset)
            _, sz = tensor_size_map[t.name]
            current_offset += sz

        for i, tensor in enumerate(mtp_tensors):
            nb = tensor.name.encode("utf-8")
            fout.write(struct.pack("<Q", len(nb))); fout.write(nb)
            shape = tensor.shape.tolist()
            fout.write(struct.pack("<I", len(shape)))
            for dim in shape:
                fout.write(struct.pack("<Q", dim))
            fout.write(struct.pack("<I", int(tensor.tensor_type)))
            fout.write(struct.pack("<Q", tensor_offsets[i]))

        # Alignment padding
        pos     = fout.tell()
        padding = (alignment - (pos % alignment)) % alignment
        if padding:
            fout.write(b"\x00" * padding)

        # Tensor data
        for tensor in mtp_tensors:
            src_t, sz = tensor_size_map[tensor.name]
            fin.seek(src_t.data_offset)
            fout.write(fin.read(sz))

    out_size = Path(mtp_path).stat().st_size
    print(f"  MTP tensors saved → {mtp_path}  ({out_size / 1e6:.1f} MB)")


# ── 5. Download SOURCE model (skip if SOURCE already exists or MTP extracted) ─
if Path(MTP_PATH).exists():
    print(f"MTP file already exists, skipping source download: {MTP_PATH}")
elif Path(SOURCE_PATH).exists():
    print(f"Source model already on disk, skipping download: {SOURCE_PATH}")
else:
    download_model(SOURCE_REPO, SOURCE_FILENAME, SOURCE_PATH, HF_TOKEN)

# ── 6. Extract MTP tensors → 35B-A3B-MTP.gguf ───────────────────────────────
if Path(MTP_PATH).exists():
    print(f"MTP file already exists, skipping extraction: {MTP_PATH}")
else:
    extract_mtp_tensors(SOURCE_PATH, MTP_PATH)

# ── 7. Delete source model from disk and free memory ────────────────────────
if Path(SOURCE_PATH).exists():
    print(f"\nDeleting source model to free disk space: {SOURCE_PATH}")
    Path(SOURCE_PATH).unlink()
    print("  Source model deleted")

gc.collect()
print("  Memory freed")

# ── 8. Download TARGET model (skip if already on disk) ───────────────────────
if Path(TARGET_PATH).exists():
    print(f"\nTarget model already on disk, skipping download: {TARGET_PATH}")
else:
    download_model(TARGET_REPO, TARGET_FILENAME, TARGET_PATH, HF_TOKEN)

# ── 9. Open files (MTP as source, TARGET as base) ────────────────────────────
print(f"\nReading target : {TARGET_PATH}")
target_reader = GGUFReader(TARGET_PATH)
print(f"Reading MTP    : {MTP_PATH}")
source_reader = GGUFReader(MTP_PATH)

target_file_size = Path(TARGET_PATH).stat().st_size
source_file_size = Path(MTP_PATH).stat().st_size

print(f"  Target tensors : {len(target_reader.tensors)}, "
      f"KVs : {len([k for k in target_reader.fields if not k.startswith('GGUF.')])}")
print(f"  MTP tensors    : {len(source_reader.tensors)}, "
      f"KVs : {len([k for k in source_reader.fields if not k.startswith('GGUF.')])}")

# ── 10. Architecture + MTP metadata ──────────────────────────────────────────
arch = get_field_value(target_reader, "general.architecture")
if arch is None:
    _abort("Target GGUF has no general.architecture key")

source_block_count = get_field_value(source_reader, f"{arch}.block_count")
source_nextn       = get_field_value(source_reader, f"{arch}.nextn_predict_layers")
target_block_count = get_field_value(target_reader, f"{arch}.block_count")

if source_nextn is None:
    _abort("MTP GGUF has no nextn_predict_layers key")

print(f"\n  Arch              : {arch}")
print(f"  Target block_count: {target_block_count}")
print(f"  Source block_count: {source_block_count},  nextn_predict_layers: {source_nextn}")

OVERRIDE_KEYS = {f"{arch}.block_count", f"{arch}.nextn_predict_layers"}

source_extra = [
    t for t in source_reader.tensors
    if t.name.startswith(f"blk.{target_block_count}.")
]
print(f"\n  Extra tensors to transplant: {len(source_extra)}")
if not source_extra:
    _abort(f"No tensors found with prefix 'blk.{target_block_count}.' in MTP file. "
           f"Available prefixes: {sorted({t.name.split('.')[1] for t in source_reader.tensors})}")

# ── 11. Tensor lists + on-disk sizes ─────────────────────────────────────────
all_tensors          = list(target_reader.tensors) + source_extra
target_on_disk_sizes = calculate_on_disk_sizes(target_reader.tensors, target_file_size)
source_on_disk_sizes = calculate_on_disk_sizes(source_reader.tensors, source_file_size)
source_tensor_map    = {
    t.name: (t, sz)
    for t, sz in zip(source_reader.tensors, source_on_disk_sizes)
}

# ── 12. KV count ──────────────────────────────────────────────────────────────
kv_count = len([k for k in target_reader.fields if not k.startswith("GGUF.")])
if f"{arch}.nextn_predict_layers" not in target_reader.fields:
    kv_count += 1

for key in source_reader.fields:
    if (
        not key.startswith("GGUF.")
        and key not in target_reader.fields
        and key not in OVERRIDE_KEYS
    ):
        kv_count += 1

# ── 13. Write output ──────────────────────────────────────────────────────────
print(f"\nWriting output : {OUTPUT_PATH}")

with (
    open(TARGET_PATH, "rb") as target_fin,
    open(MTP_PATH,    "rb") as source_fin,
    open(OUTPUT_PATH, "wb") as fout,
):
    # Header
    fout.write(b"GGUF")
    fout.write(struct.pack("<I", 3))
    fout.write(struct.pack("<Q", len(all_tensors)))
    fout.write(struct.pack("<Q", kv_count))

    written_keys = set()

    # ── 13a. Target KVs (skip overridden keys) ──────────────────────
    for key, field in target_reader.fields.items():
        if key.startswith("GGUF.") or key in OVERRIDE_KEYS:
            continue

        key_bytes = key.encode("utf-8")
        fout.write(struct.pack("<Q", len(key_bytes))); fout.write(key_bytes)

        kv_type = field.types[0]
        fout.write(struct.pack("<I", int(kv_type)))

        if kv_type == GGUFValueType.ARRAY:
            sub_type = field.types[1] if len(field.types) > 1 else GGUFValueType.FLOAT32
            write_array_value(fout, sub_type, field.contents())
        else:
            write_kv_value(fout, kv_type, field.contents())

        written_keys.add(key)

    # ── 13b. Overridden keys — always written from source ───────────
    for key, value in [
        (f"{arch}.block_count",          source_block_count),
        (f"{arch}.nextn_predict_layers", source_nextn),
    ]:
        key_bytes = key.encode("utf-8")
        fout.write(struct.pack("<Q", len(key_bytes))); fout.write(key_bytes)
        fout.write(struct.pack("<I", int(GGUFValueType.UINT32)))
        fout.write(struct.pack("<I", value))
        written_keys.add(key)

    # ── 13c. Source-only KVs ────────────────────────────────────────
    for key, field in source_reader.fields.items():
        if key.startswith("GGUF.") or key in written_keys:
            continue

        key_bytes = key.encode("utf-8")
        fout.write(struct.pack("<Q", len(key_bytes))); fout.write(key_bytes)

        kv_type = field.types[0]
        fout.write(struct.pack("<I", int(kv_type)))

        if kv_type == GGUFValueType.ARRAY:
            sub_type = field.types[1] if len(field.types) > 1 else GGUFValueType.FLOAT32
            write_array_value(fout, sub_type, field.contents())
        else:
            write_kv_value(fout, kv_type, field.contents())

    # ── 13d. Tensor info ────────────────────────────────────────────
    current_offset = 0
    tensor_offsets = []
    for i, tensor in enumerate(all_tensors):
        size = (target_on_disk_sizes[i] if i < len(target_reader.tensors)
                else source_tensor_map[tensor.name][1])
        tensor_offsets.append(current_offset)
        current_offset += size

    for i, tensor in enumerate(all_tensors):
        name_bytes = tensor.name.encode("utf-8")
        fout.write(struct.pack("<Q", len(name_bytes))); fout.write(name_bytes)

        shape = tensor.shape.tolist()
        fout.write(struct.pack("<I", len(shape)))
        for dim in shape:
            fout.write(struct.pack("<Q", dim))

        fout.write(struct.pack("<I", int(tensor.tensor_type)))
        fout.write(struct.pack("<Q", tensor_offsets[i]))

    # ── 13e. Alignment padding ──────────────────────────────────────
    alignment   = get_field_value(target_reader, "general.alignment") or 32
    current_pos = fout.tell()
    padding     = (alignment - (current_pos % alignment)) % alignment
    if padding:
        fout.write(b"\x00" * padding)

    # ── 13f. Tensor data ────────────────────────────────────────────
    print(f"Copying {len(all_tensors)} tensors...")
    for i, tensor in enumerate(all_tensors):
        if i < len(target_reader.tensors):
            offset = target_reader.tensors[i].data_offset
            size   = target_on_disk_sizes[i]
            fin    = target_fin
        else:
            src_tensor, size = source_tensor_map[tensor.name]
            offset = src_tensor.data_offset
            fin    = source_fin

        fin.seek(offset)
        fout.write(fin.read(size))

        if (i + 1) % 50 == 0 or i == len(all_tensors) - 1:
            print(f"  Copied {i + 1}/{len(all_tensors)} tensors")

# ── 14. Verify ────────────────────────────────────────────────────────────────
output_size = Path(OUTPUT_PATH).stat().st_size
print(f"\nOutput : {OUTPUT_PATH}")
print(f"  Size   : {output_size / 1_000_000_000:.2f} GB")
print(f"  Tensors: {len(all_tensors)}")

print("\nValidating output...")
errors = []

try:
    out_reader = GGUFReader(OUTPUT_PATH)

    out_block_count = get_field_value(out_reader, f"{arch}.block_count")
    if out_block_count != source_block_count:
        errors.append(f"block_count: expected {source_block_count}, got {out_block_count}")

    out_nextn = get_field_value(out_reader, f"{arch}.nextn_predict_layers")
    if out_nextn != source_nextn:
        errors.append(f"nextn_predict_layers: expected {source_nextn}, got {out_nextn}")

    out_tensor_names = {t.name for t in out_reader.tensors}
    for tensor in source_extra:
        if tensor.name not in out_tensor_names:
            errors.append(f"Missing tensor: {tensor.name}")

    print("  Spot-checking tensor data integrity...")
    out_tensors = {t.name: t for t in out_reader.tensors}

    for name in ["token_embd.weight"]:
        if name in out_tensors and name in {t.name for t in target_reader.tensors}:
            target_t = next((t for t in target_reader.tensors if t.name == name), None)
            out_t    = out_tensors.get(name)
            if target_t and out_t:
                th = hashlib.sha256(target_t.data.tobytes()).hexdigest()[:16]
                oh = hashlib.sha256(out_t.data.tobytes()).hexdigest()[:16]
                if th == oh:
                    print(f"    {name}: OK ({oh})")
                else:
                    errors.append(f"Data mismatch: {name}")

    if source_extra:
        extra_name = source_extra[0].name
        source_t   = source_tensor_map[extra_name][0]
        out_t      = out_tensors.get(extra_name)
        if out_t:
            sh = hashlib.sha256(source_t.data.tobytes()).hexdigest()[:16]
            oh = hashlib.sha256(out_t.data.tobytes()).hexdigest()[:16]
            if sh == oh:
                print(f"    {extra_name}: OK ({oh})")
            else:
                errors.append(f"Data mismatch: {extra_name}")

except Exception as e:
    errors.append(f"Failed to read output: {e}")

if errors:
    print("\n VALIDATION FAILED:")
    for err in errors:
        print(f"  - {err}")
    raise RuntimeError("Validation failed — see errors above.")
else:
    print("  All checks passed")
    print(f"\nDone. Output: {OUTPUT_PATH}")
