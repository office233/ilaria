"""forge/nxtf3.py -- shared NXTF v3 (`NXTF3BIN`) writer, factored out of
forge/import_bitnet.py so a second exporter (forge/multimodal/export_tower.py,
which writes a `siglip2_vision` arch rather than `bitnet`) can produce the
same container format without duplicating the streaming-writer code or
import_bitnet.py's `arch` string.

Format (little-endian throughout):

    magic   8 bytes  "NXTF3BIN"
    hdrLen  uint32   length of the JSON header that follows
    header  JSON     {"version": 3, "arch": <str>, "config": {...},
                      "tensors": [{"name","kind","shape","offset","bytes",
                                   "scale"?}, ...]}
    blobs            each tensor's raw bytes, back-to-back; a tensor's
                      "offset"/"bytes" fields are relative to the start of
                      the blob region (immediately after the header).

`arch` and `config` are caller-supplied and opaque to this module -- it only
streams tensor blobs to a temp file (so it never holds more than one
tensor's raw bytes in memory at once) and concatenates
magic+header+blobs into the final file on `finalize()`. import_bitnet.py's
own `write_top`/`write_layer`/ternary-packing helpers stay there (they are
`arch: "bitnet"`-specific); this module only owns the container.

`import_bitnet.py` imports `NXTFWriter` from here and calls it with
`arch="bitnet"`, so its output is byte-for-byte unchanged from before this
module existed.
"""

from __future__ import annotations

import json
import os
import shutil
import struct
from typing import Any

MAGIC = b"NXTF3BIN"


class NXTFWriter:
    """Streams tensor blobs to a temp file, then concatenates
    magic+header+blobs into the final file on finalize(). `arch` is written
    verbatim into the header's "arch" field (e.g. "bitnet", "siglip2_vision")
    -- the Go-side loader for that arch rejects any other value."""

    def __init__(self, out_path: str, arch: str, config: dict[str, Any]):
        self.out_path = out_path
        self.arch = arch
        self.config = config
        self.tensors: list[dict[str, Any]] = []
        os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
        self._tmp_path = out_path + ".blob.tmp"
        self._tmp = open(self._tmp_path, "wb")
        self._offset = 0

    def add(self, name: str, kind: str, shape: list[int], data: bytes, scale: float | None = None) -> None:
        entry: dict[str, Any] = {
            "name": name,
            "kind": kind,
            "shape": list(shape),
            "offset": self._offset,
            "bytes": len(data),
        }
        if scale is not None:
            entry["scale"] = float(scale)
        self.tensors.append(entry)
        self._tmp.write(data)
        self._offset += len(data)

    def finalize(self) -> None:
        self._tmp.close()
        header = {
            "version": 3,
            "arch": self.arch,
            "config": self.config,
            "tensors": self.tensors,
        }
        hdr_bytes = json.dumps(header).encode("utf-8")
        with open(self.out_path, "wb") as out:
            out.write(MAGIC)
            out.write(struct.pack("<I", len(hdr_bytes)))
            out.write(hdr_bytes)
            with open(self._tmp_path, "rb") as tmp:
                shutil.copyfileobj(tmp, out, length=4 * 1024 * 1024)
        os.remove(self._tmp_path)


def f32_bytes(arr) -> bytes:
    """np.ndarray (any shape/dtype) -> contiguous little-endian float32
    bytes. Shared by every NXTF v3 writer that stores plain float tensors."""
    import numpy as np

    return np.ascontiguousarray(arr, dtype="<f4").tobytes()
