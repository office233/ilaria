#!/usr/bin/env python3
"""Generate an explicit first-party SWYDRV1 task, not a built-in boot workload."""
import argparse
import struct
from pathlib import Path


def build_image(mode="success"):
    if mode not in ("success", "loop"):
        raise ValueError("unsupported init probe mode")
    code = bytearray()
    failures = []

    def require_equal():
        code.extend(b"\x0f\x85")
        failures.append(len(code))
        code.extend(b"\0" * 4)

    # Read CS in the task: a wrong privilege level exits with failure code 99.
    code.extend(bytes.fromhex("66 8c c8 83 e0 03 83 f8 03"))
    require_equal()
    code.extend(bytes.fromhex("b8 02 00 00 00 cd 80 48 89 c6 48 83 f8 01"))
    require_equal()
    code.extend(bytes.fromhex("b8 04 00 00 00 cd 80"))  # YIELD; resume at the next instruction
    if mode == "loop":
        code.extend(b"\xeb\xfe")
    else:
        code.extend(bytes.fromhex("bf 2a 00 00 00 b8 05 00 00 00 cd 80 0f 0b"))
    failed = len(code)
    code.extend(bytes.fromhex("bf 63 00 00 00 b8 05 00 00 00 cd 80 0f 0b"))
    for position in failures:
        struct.pack_into("<i", code, position, failed - position - 4)

    image = bytearray(0x100 + len(code))
    struct.pack_into("<8sHHH", image, 0, b"SWYDRV1\0", 1, 64, 1)
    struct.pack_into("<QQ", image, 24, 0, 4096)
    struct.pack_into("<QQQQQQ", image, 64, 0, 0x100, len(code), 4096, 5, 0)
    image[0x100:] = code
    return bytes(image)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--mode", choices=("success", "loop"), default="success")
    args = parser.parse_args()
    # Never overwrite a user's supplied boot image.
    with args.output.open("xb") as stream:
        stream.write(build_image(args.mode))


if __name__ == "__main__":
    main()
