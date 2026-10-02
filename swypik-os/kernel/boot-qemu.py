#!/usr/bin/env python3
"""Boot the SwypikOS native kernel EFI image under OVMF in QEMU and prove how far
it gets.

The kernel prints to UEFI ConOut only before ExitBootServices and then halts by
design, so success after the takeover is not visible as output. This harness:

1. boots the image from a FAT ESP with OVMF (no network, no reboot on fault);
2. requires the pre-handoff banner/stage/handoff lines on the serial console;
3. waits for the vCPU to halt, then reads RIP/CR3/HLT through the QEMU monitor;
4. dumps guest RAM and locates SwypBootInfo by its magic ("SWYPIKBI") to read
   boot_flags, which records every completed post-ExitBootServices stage;
5. requires that QEMU never reset (a triple fault exits under -no-reboot).

Tools are taken from explicit paths or PATH; nothing is installed.
"""
import argparse
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time

MAGIC = 0x49424B4950595753  # SWYP_BOOT_INFO_MAGIC, bytes "SWYPIKBI"
FLAGS = [
    "EXITED_BOOT_SERVICES", "PAGE_ALLOCATOR_READY", "KERNEL_ROOT_ACTIVE", "DIRECT_MAP_READY",
    "PRIVILEGE_READY", "EMERGENCY_IDT_READY", "TRAP_ABI_READY", "PLATFORM_READY",
    "SCHEDULER_READY", "DRIVER_ABI_READY", "IOMMU_READY",
]
REQUIRED_RUNTIME = (1 << 10) - 1  # bits 0..9: everything before swyp_kernel_entry_runtime
BANNER = ["SwypikOS native kernel seed", "stage=uefi-loader arch=x86_64", "handoff=kernel boot-services=exiting"]


def monitor(sock_path, command, timeout=30.0):
    deadline = time.monotonic() + timeout
    while True:
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.connect(sock_path)
            break
        except OSError:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.1)
    s.settimeout(timeout)
    data = b""
    while b"(qemu)" not in data:
        data += s.recv(65536)
    s.sendall(command.encode() + b"\n")
    data = b""
    while data.count(b"(qemu)") < 1:
        chunk = s.recv(65536)
        if not chunk:
            break
        data += chunk
    s.close()
    text = data.decode(errors="replace")
    return text.split("(qemu)")[0]


def register(text, name):
    for token in text.replace("\n", " ").split():
        if token.startswith(name + "="):
            return token.split("=", 1)[1]
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--efi", required=True, help="BOOTX64.EFI to boot")
    parser.add_argument("--qemu", default=shutil.which("qemu-system-x86_64") or "qemu-system-x86_64")
    parser.add_argument("--qemu-data", action="append", default=[], help="QEMU firmware/ROM data directory (-L); repeatable")
    parser.add_argument("--ovmf-code", required=True)
    parser.add_argument("--ovmf-vars", required=True)
    parser.add_argument("--memory-mib", type=int, default=512)
    parser.add_argument("--cpus", type=int, default=1)
    parser.add_argument("--iommu", action="store_true", help="add an emulated Intel VT-d IOMMU")
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--hmp", action="append", default=[], help="extra QEMU monitor command after halt; {rip}/{rsp} expand")
    parser.add_argument("--out", default="", help="evidence directory (kept); default: temporary")
    args = parser.parse_args()

    work = args.out or tempfile.mkdtemp(prefix="swypik-qemu-boot-")
    os.makedirs(work, exist_ok=True)
    esp = os.path.join(work, "esp")
    os.makedirs(os.path.join(esp, "EFI", "BOOT"), exist_ok=True)
    shutil.copyfile(args.efi, os.path.join(esp, "EFI", "BOOT", "BOOTX64.EFI"))
    vars_copy = os.path.join(work, "OVMF_VARS.fd")
    shutil.copyfile(args.ovmf_vars, vars_copy)
    serial = os.path.join(work, "serial.log")
    qlog = os.path.join(work, "qemu.log")
    mon = os.path.join(work, "monitor.sock")
    for path in (serial, qlog, mon):
        if os.path.exists(path):
            os.remove(path)
    machine = "q35,kernel-irqchip=split" if args.iommu else "q35"
    cmd = [args.qemu]
    for data_dir in args.qemu_data:
        cmd += ["-L", data_dir]
    cmd += ["-machine", machine, "-accel", "tcg", "-cpu", "max", "-smp", str(args.cpus),
           "-m", str(args.memory_mib), "-display", "none", "-no-reboot", "-net", "none",
           "-drive", f"if=pflash,format=raw,readonly=on,file={args.ovmf_code}",
           "-drive", f"if=pflash,format=raw,file={vars_copy}",
           "-drive", f"format=raw,file=fat:rw:{esp}",
           "-serial", f"file:{serial}", "-monitor", f"unix:{mon},server,nowait",
           "-d", "cpu_reset,guest_errors", "-D", qlog]
    if args.iommu:
        cmd += ["-device", "intel-iommu,intremap=on"]
    started = time.monotonic()
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    result = {"efi": os.path.abspath(args.efi), "machine": machine, "cpus": args.cpus,
              "memory_mib": args.memory_mib, "accel": "tcg", "evidence": work}
    try:
        def serial_text():
            try:
                with open(serial, "rb") as stream:
                    return stream.read().decode("utf-8", errors="replace")
            except OSError:
                return ""

        while time.monotonic() - started < args.timeout and BANNER[2] not in serial_text():
            if proc.poll() is not None:
                break
            time.sleep(0.2)
        result["handoff_seconds"] = round(time.monotonic() - started, 2)
        result["serial_lines_seen"] = [line for line in BANNER if line in serial_text()]
        halted = False
        regs = ""
        while time.monotonic() - started < args.timeout and proc.poll() is None:
            regs = monitor(mon, "info registers")
            if register(regs, "HLT") == "1":
                halted = True
                break
            time.sleep(0.5)
        result["qemu_alive"] = proc.poll() is None
        result["halted"] = halted
        result["rip"] = register(regs, "RIP")
        result["cr3"] = register(regs, "CR3")
        result["rsp"] = register(regs, "RSP")
        gdt_match = re.search(r"GDT=\s+([0-9a-f]+)\s+([0-9a-f]+)", regs)
        tr_match = re.search(r"TR =([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)", regs)
        result["gdt_base"] = gdt_match.group(1) if gdt_match else None
        result["tr"] = tr_match.groups() if tr_match else None
        if result["qemu_alive"] and args.hmp:
            result["hmp"] = {}
            for template in args.hmp:
                command = template.format(rip="0x" + (result["rip"] or "0"), rsp="0x" + (result["rsp"] or "0"),
                                          gdt="0x" + (result["gdt_base"] or "0"))
                result["hmp"][command] = monitor(mon, command).strip().splitlines()[1:]
        if result["qemu_alive"]:
            dump = os.path.join(work, "guest-ram.bin")
            reply = monitor(mon, f"pmemsave 0 {args.memory_mib * 1024 * 1024} \"{dump}\"", timeout=120.0)
            for _ in range(600):
                if os.path.exists(dump) and os.path.getsize(dump) == args.memory_mib * 1024 * 1024:
                    break
                time.sleep(0.1)
            if not os.path.exists(dump):
                raise RuntimeError(f"pmemsave produced no dump; monitor replied: {reply!r}")
            with open(dump, "rb") as stream:
                ram = stream.read()
            os.remove(dump)
            needle = struct.pack("<Q", MAGIC)
            candidates = []
            at = ram.find(needle)
            while at >= 0 and len(candidates) < 16:
                abi, size = struct.unpack_from("<II", ram, at + 8)
                if 32 <= size <= 4096 and at + size <= len(ram) and size % 8 == 0:
                    fw_table = struct.unpack_from("<Q", ram, at + 24)[0]
                    flags = struct.unpack_from("<Q", ram, at + size - 8)[0]
                    candidates.append({"physical": hex(at), "abi_version": abi, "struct_size": size,
                                       "firmware_system_table": hex(fw_table), "boot_flags": hex(flags),
                                       "stages": [name for bit, name in enumerate(FLAGS) if flags >> bit & 1]})
                at = ram.find(needle, at + 8)
            result["boot_info"] = candidates
            monitor(mon, "quit")
        proc.wait(timeout=30)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    with open(qlog, "r", errors="replace") as stream:
        log = stream.read()
    result["cpu_resets_logged"] = log.count("CPU Reset")
    result["guest_errors"] = [line for line in log.splitlines() if "guest_errors" in line or "invalid" in line.lower()][:10]
    serial_text_final = ""
    try:
        with open(serial, "rb") as stream:
            serial_text_final = stream.read().decode("utf-8", errors="replace")
    except OSError:
        pass
    result["serial_tail"] = serial_text_final[-600:]
    # Post-handoff proof: the live SwypBootInfo has the firmware table cleared
    # after ExitBootServices; pick the candidate with the most stages.
    live = [c for c in result.get("boot_info", []) if c["firmware_system_table"] == "0x0"]
    best = max(live, key=lambda c: int(c["boot_flags"], 16), default=None)
    result["live_boot_info"] = best
    flags = int(best["boot_flags"], 16) if best else 0
    checks = {
        "serial_banner_and_handoff": result["serial_lines_seen"] == BANNER,
        "no_reset_or_triple_fault": result["qemu_alive"],
        "vcpu_halted": result["halted"],
        "exited_boot_services": bool(flags & 1),
        "runtime_handoff_reached": flags & REQUIRED_RUNTIME == REQUIRED_RUNTIME,
    }
    result["checks"] = checks
    result["status"] = "PASS" if all(checks.values()) else "FAIL"
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
