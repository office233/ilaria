"""Validate Go-project files that explicitly reference the repository LICENSE."""
from __future__ import annotations

import re
from pathlib import Path


GO_LICENSE_EVIDENCE_KIND = "go-root-license-reference-v1"
GO_DECLARED_SPDX = "BSD-3-Clause"
_COPYRIGHT = re.compile(
    rb"Copyright [0-9]{4}(?:-[0-9]{4})? The Go Authors\. All rights reserved\."
)
_LICENSE_REFERENCE = (
    b"Use of this source code is governed by a BSD-style\n"
    b"// license that can be found in the LICENSE file."
)
_LICENSE_REFERENCE_HASH = (
    b"Use of this source code is governed by a BSD-style\n"
    b"# license that can be found in the LICENSE file."
)


def has_go_root_license_reference(
    path: str | Path,
    *,
    max_bytes: int = 16 * 1024,
) -> bool:
    """Return true only for files carrying Go's explicit root-license notice."""
    with Path(path).open("rb") as stream:
        prefix = stream.read(max_bytes).replace(b"\r\n", b"\n")
    if _COPYRIGHT.search(prefix) is None:
        return False
    return (
        _LICENSE_REFERENCE in prefix
        or _LICENSE_REFERENCE_HASH in prefix
    )
