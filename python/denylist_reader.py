#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Deny List reader for FlatBuffers (Python)
- รองรับไฟล์ .bin/.zip และ deflate/zlib
- สร้าง reasons lookup + index ด้วย surrogate PAN
- CLI:
    --pan, --list, --stats
    --export-csv PATH
    --export-json PATH   (พิเศษ: PATH=="-" จะพิมพ์ JSON ออก stdout)
    --json-stdout        (พิมพ์ JSON ออก stdout เสมอ)
    --suppress-id-warn
"""

from __future__ import annotations
import argparse
import sys
import zlib
import zipfile
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
from collections import Counter
import csv
import json
import inspect
import os

# === FlatBuffers generated modules ===
try:
    from TransCity.DenyList import DenyList
    from TransCity.DenyListEntry import DenyListEntry
    from TransCity.DenyReason import DenyReason
except ModuleNotFoundError:
    # fallback: no namespace
    from DenyList import DenyList  # type: ignore
    from DenyListEntry import DenyListEntry  # type: ignore
    from DenyReason import DenyReason  # type: ignore

@dataclass
class DenyEntry:
    surrogate_pan: str
    removed_present: bool
    removed: bool
    reason_ids: List[int]
    reason_labels: List[str]

@dataclass
class DenyListModel:
    reasons: Dict[int, str]
    entries_by_pan: Dict[str, DenyEntry]

def _maybe_inflate(data: bytes) -> bytes:
    try:
        return zlib.decompress(data, -zlib.MAX_WBITS)
    except zlib.error:
        pass
    try:
        return zlib.decompress(data)
    except zlib.error:
        return data

def _read_first_bin_in_zip(zip_path: str) -> bytes:
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = zf.namelist()
        target = next((n for n in names if n.lower().endswith(".bin")), names[0] if names else None)
        if not target:
            raise FileNotFoundError("ZIP is empty.")
        with zf.open(target, "r") as f:
            return f.read()

def _load_bytes_from_path(path: str) -> bytes:
    if path.lower().endswith(".zip"):
        data = _read_first_bin_in_zip(path)
    else:
        with open(path, "rb") as f:
            data = f.read()
    return _maybe_inflate(data)

def _b2s(x) -> str:
    if isinstance(x, (bytes, bytearray, memoryview)):
        return bytes(x).decode("utf-8", errors="replace")
    return x if isinstance(x, str) else str(x)

def _vec_get(getter, idx: int, cls):
    try:
        sig = inspect.signature(getter)
        if len(sig.parameters) == 2:
            obj = cls()
            res = getter(obj, idx)
            return obj if res is None else res
        return getter(idx)
    except TypeError:
        try:
            return getter(idx)
        except TypeError:
            obj = cls()
            getter(obj, idx)
            return obj

def parse_denylist_bytes(data: bytes, suppress_id_warn: bool = False) -> DenyListModel:
    mv = memoryview(data)
    try:
        has_id_fn = getattr(DenyList, "DenyListBufferHasIdentifier", None)
        if callable(has_id_fn):
            if not has_id_fn(mv, 0) and not suppress_id_warn:
                print("[WARN] Buffer file_identifier mismatch.", file=sys.stderr)
    except Exception:
        pass

    root = DenyList.GetRootAsDenyList(mv, 0)

    reasons: Dict[int, str] = {}
    n_reasons = getattr(root, "DenyReasonsLength", lambda: 0)()
    for i in range(n_reasons):
        r = _vec_get(root.DenyReasons, i, DenyReason)
        rid = int(r.Id())
        reasons[rid] = _b2s(r.Value())

    entries_by_pan: Dict[str, DenyEntry] = {}
    n_entries = getattr(root, "DenyListEntriesLength", lambda: 0)()
    for i in range(n_entries):
        e = _vec_get(root.DenyListEntries, i, DenyListEntry)
        get_pan = getattr(e, "SurrogatePAN", None) or getattr(e, "SurrogatePan", None)
        if not get_pan:
            raise AttributeError("DenyListEntry has no SurrogatePAN/SurrogatePan()")
        pan = _b2s(get_pan())
        ids = [int(e.DenyReasonsId(j)) for j in range(e.DenyReasonsIdLength())]
        labels = [reasons.get(x, f"UNKNOWN({x})") for x in ids]

        removed_present = False
        removed_val = False
        if hasattr(e, "RemovedIsNone") and callable(getattr(e, "RemovedIsNone")):
            removed_present = not e.RemovedIsNone()
            removed_val = bool(e.Removed()) if removed_present else False
        else:
            removed_val = bool(e.Removed())

        entries_by_pan[pan] = DenyEntry(
            surrogate_pan=pan,
            removed_present=removed_present,
            removed=removed_val,
            reason_ids=ids,
            reason_labels=labels,
        )
    return DenyListModel(reasons=reasons, entries_by_pan=entries_by_pan)

def load_denylist(path_or_bytes: str | bytes, suppress_id_warn: bool = False) -> DenyListModel:
    data = _load_bytes_from_path(path_or_bytes) if isinstance(path_or_bytes, str) else _maybe_inflate(bytes(path_or_bytes))
    return parse_denylist_bytes(data, suppress_id_warn=suppress_id_warn)

def _entry_to_row(e: DenyEntry) -> Dict[str, str]:
    return {
        "pan": e.surrogate_pan,
        "removed": "true" if e.removed else "false",
        "removed_present": "true" if e.removed_present else "false",
        "reason_ids": ",".join(str(x) for x in e.reason_ids),
        "reason_labels": ",".join(e.reason_labels),
    }

def write_csv(path: str, model: DenyListModel) -> None:
    rows = [_entry_to_row(e) for e in model.entries_by_pan.values()]
    fieldnames = ["pan", "removed", "removed_present", "reason_ids", "reason_labels"]
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader(); w.writerows(rows)

def write_json(path: str, model: DenyListModel) -> None:
    out = {
        "reasons": {int(k): v for k, v in model.reasons.items()},
        "entries": [_entry_to_row(e) for e in model.entries_by_pan.values()],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

def json_stdout(model: DenyListModel) -> None:
    out = {
        "reasons": {int(k): v for k, v in model.reasons.items()},
        "entries": [_entry_to_row(e) for e in model.entries_by_pan.values()],
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    sys.stdout.flush()

def print_stats(model: DenyListModel) -> None:
    total = len(model.entries_by_pan)
    c = Counter()
    for e in model.entries_by_pan.values():
        c.update(e.reason_ids)
    print(f"Total entries: {total}")
    print("Counts by reason id:")
    for rid, cnt in sorted(c.items()):
        label = model.reasons.get(rid, f"UNKNOWN({rid})")
        print(f"  {rid:>3}  {label:<16}  {cnt}")
    removed_true = sum(1 for e in model.entries_by_pan.values() if e.removed)
    print(f"Removed=true: {removed_true}")
    print(f"Removed=false: {total - removed_true}")

def main():
    p = argparse.ArgumentParser(description="Read/Query Deny List (FlatBuffers).")
    p.add_argument("input", help="path to .bin or .zip (deflate/zlib supported)")
    p.add_argument("--pan", help="surrogate PAN to check (exact match)")
    p.add_argument("--list", action="store_true", help="print all entries")
    p.add_argument("--stats", action="store_true", help="show summary stats")
    p.add_argument("--export-csv", metavar="PATH", help="export entries to CSV")
    p.add_argument("--export-json", metavar="PATH", help="export entries+reasons to JSON (use '-' for stdout)")
    p.add_argument("--json-stdout", action="store_true", help="print JSON to stdout (same shape as --export-json)")
    p.add_argument("--suppress-id-warn", action="store_true", help="suppress file_identifier mismatch warning")
    args = p.parse_args()

    model = load_denylist(args.input, suppress_id_warn=args.suppress_id_warn)

    if args.json_stdout or (args.export_json == "-"):
      json_stdout(model)
      return

    if args.pan:
        ok = args.pan in model.entries_by_pan
        if ok:
            e = model.entries_by_pan[args.pan]
            print("[DENIED]", e.surrogate_pan, e.reason_ids, e.reason_labels, "removed=", e.removed)
        else:
            print("[OK] Not in deny list.")

    if args.stats:
        print_stats(model)

    if args.export_csv:
        write_csv(args.export_csv, model)
        print(f"[OK] exported CSV -> {args.export_csv}")

    if args.export_json and args.export_json != "-":
        write_json(args.export_json, model)
        print(f"[OK] exported JSON -> {args.export_json}")

    if args.list:
        print(f"# Reasons ({len(model.reasons)}):")
        for rid, label in sorted(model.reasons.items()):
            print(f"- {rid}: {label}")
        print(f"\n# Entries ({len(model.entries_by_pan)}):")
        for pan, e in sorted(model.entries_by_pan.items()):
            print(e.surrogate_pan, e.reason_ids, e.reason_labels, e.removed)

if __name__ == "__main__":
    main()
