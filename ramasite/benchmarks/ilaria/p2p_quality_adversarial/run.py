from __future__ import annotations

import argparse
import json
from pathlib import Path
import time

from cases import run_cases


def main() -> int:
    parser = argparse.ArgumentParser(description="Run bounded synthetic Ilaria quality-gate probes")
    parser.add_argument("--canonical-root", type=Path, required=True,
                        help="checkout containing the pinned public Ilaria sources")
    parser.add_argument("--output", type=Path, required=True,
                        help="new receipt path; existing files are never overwritten")
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError(f"refusing to overwrite existing receipt: {args.output}")
    started = time.monotonic()
    receipt = run_cases(args.canonical_root)
    receipt["runtime_seconds"] = round(time.monotonic() - started, 3)
    if receipt["runtime_seconds"] > 600:
        raise RuntimeError("benchmark exceeded its 10-minute runtime budget")
    receipt["canonical_root"] = str(args.canonical_root.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(receipt, indent=2, sort_keys=True) + "\n"
    with args.output.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(payload)
    print(json.dumps(receipt, indent=2, sort_keys=True))
    print(f"receipt={args.output.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
