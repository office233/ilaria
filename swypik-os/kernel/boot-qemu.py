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
    "INIT_IMAGE_READY", "INIT_REFUSED", "INIT_YIELDED", "INIT_EXITED", "INIT_CLEANED", "INIT_FAILED",
    "RUNTIME_HANDOFF_VALIDATED",
    "INIT_FAULTED",
]
REQUIRED_RUNTIME = (1 << 10) - 1  # bits 0..9: everything before swyp_kernel_entry_runtime
BANNER = ["SwypikOS native kernel seed", "stage=uefi-loader arch=x86_64", "handoff=kernel boot-services=exiting"]

def boot_info_candidates(ram):
    needle = struct.pack("<Q", MAGIC)
    candidates = []
    at = ram.find(needle)
    while at >= 0 and at + 16 <= len(ram) and len(candidates) < 16:
        abi, size = struct.unpack_from("<II", ram, at + 8)
        # Known append-only ABI v1 layouts; do not guess offsets for an
        # unknown version/size or decode a truncated extension.
        if abi == 1 and size in (168, 232, 320) and at + size <= len(ram):
            fw_table = struct.unpack_from("<Q", ram, at + 24)[0]
            flags = struct.unpack_from("<Q", ram, at + 160)[0]
            candidate = {"physical": hex(at), "abi_version": abi, "struct_size": size,
                         "firmware_system_table": hex(fw_table), "boot_flags": hex(flags),
                         "stages": [name for bit, name in enumerate(FLAGS) if flags >> bit & 1]}
            if size >= 232:
                init = struct.unpack_from("<QQQiIQQQQ", ram, at + 168)
                candidate["init"] = dict(zip(
                    ("image_address", "image_bytes", "image_pages", "status", "reserved",
                     "yields", "preemptions", "exit_code", "observed_domain"), init))
            if size == 320:
                fault = struct.unpack_from("<II9QiI", ram, at + 232)
                candidate["init"]["fault"] = dict(zip(
                    ("version", "struct_size", "thread_id", "domain_id", "lease_fence", "vector",
                     "error_code", "address", "rip", "cs", "kernel_cr3", "status", "reserved"), fault))
            candidates.append(candidate)
        at = ram.find(needle, at + 8)
    return candidates


def expected_fault_checks(flags, init, cr3, vector, error=None, address=None):
    fault = init.get("fault", {})
    required = (1 << 11) | (1 << 15) | (1 << 16) | (1 << 17) | (1 << 18)
    checks = {
        "fault_cleanup_and_final_handoff": flags & required == required,
        "fault_not_successful_exit": not flags & ((1 << 12) | (1 << 14)) and init.get("exit_code") == 0,
        "fault_status_recorded": init.get("status") == -8 and fault.get("status") == -8,
        "fault_record_layout": fault.get("version") == 1 and fault.get("struct_size") == 88 and
                              fault.get("reserved") == 0,
        "fault_task_epoch_and_cpl": (fault.get("thread_id"), fault.get("domain_id"),
                                    fault.get("lease_fence"), fault.get("cs")) == (1, 1, 1, 0x23),
        "fault_vector_recorded": fault.get("vector") == vector and fault.get("rip", 0) != 0,
        "fault_kernel_cr3_restored": fault.get("kernel_cr3", 0) != 0 and fault.get("kernel_cr3") == cr3,
        "fault_address_semantics": fault.get("address") == 0 if vector != 14 else
                                   bool(fault.get("error_code", 0) & 4) and not fault.get("error_code", 0) & 8,
    }
    if error is not None:
        checks["fault_expected_error"] = fault.get("error_code") == error
    if address is not None:
        checks["fault_expected_address"] = fault.get("address") == address
    return checks


def monitor(sock_path, command, timeout=30.0):
    deadline = time.monotonic() + timeout
    while True:
        try:
            s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            s.connect(sock_path)
            break
        except OSError:
            s.close()
            if time.monotonic() > deadline:
                raise
            time.sleep(0.1)
    s.settimeout(timeout)
    data = b""
    while b"(qemu)" not in data:
        chunk = s.recv(65536)
        if not chunk:
            s.close()
            raise ConnectionError("QEMU monitor closed before its prompt")
        data += chunk
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

def user_timer_evidence(log):
    count = odd = enabled = 0
    examples = []
    lines = log.splitlines()
    pattern = re.compile(r"v=e0 .*cpl=3 IP=0023:([0-9a-f]+).* SP=001b:([0-9a-f]+)")
    for index, line in enumerate(lines):
        match = pattern.search(line)
        if not match:
            continue
        flags = None
        for register_line in lines[index + 1:index + 8]:
            flag_match = re.search(r"RFL=([0-9a-f]+)", register_line)
            if flag_match:
                flags = int(flag_match.group(1), 16)
                break
        count += 1
        rsp = int(match.group(2), 16)
        odd += rsp % 16 == 8
        enabled += flags is not None and bool(flags & 0x200)
        if len(examples) < 4:
            examples.append({"rip": match.group(1), "rsp": match.group(2), "rflags": flags})
    return {"count": count, "rsp_mod16_8": odd, "if_enabled": enabled, "examples": examples}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--efi", required=True, help="BOOTX64.EFI to boot")
    parser.add_argument("--qemu", default=shutil.which("qemu-system-x86_64") or "qemu-system-x86_64")
    parser.add_argument("--qemu-data", action="append", default=[], help="QEMU firmware/ROM data directory (-L); repeatable")
    parser.add_argument("--ovmf-code", required=True)
    parser.add_argument("--ovmf-vars", required=True)
    parser.add_argument("--memory-mib", type=int, default=512)
    parser.add_argument("--cpus", type=int, default=1)
    parser.add_argument("--cpu", default="max", help="explicit QEMU CPU/features; unsupported features are not proof")
    parser.add_argument("--iommu", action="store_true", help="add an emulated Intel VT-d IOMMU")
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--hmp", action="append", default=[], help="extra QEMU monitor command after halt; {rip}/{rsp} expand")
    parser.add_argument("--out", default="", help="evidence directory (kept); default: temporary")
    parser.add_argument("--init", help="explicit SWYDRV1 file placed at EFI/SWYPIK/INIT.SWD")
    parser.add_argument("--init-outcome", choices=("exited", "refused", "limited", "fault"), default="exited")
    parser.add_argument("--expected-exit", type=int, default=42)
    parser.add_argument("--expected-fault-vector", type=lambda value: int(value, 0))
    parser.add_argument("--expected-fault-error", type=lambda value: int(value, 0))
    parser.add_argument("--expected-fault-address", type=lambda value: int(value, 0))
    parser.add_argument("--trace-interrupts", action="store_true", help="include interrupt/exception diagnostics")
    parser.add_argument("--require-call-stack-preemption", action="store_true",
                        help="require repeated CPL3 timer frames, RSP%%16=8 and saved IF=1 (enables trace)")
    args = parser.parse_args()
    if args.memory_mib < 128 or args.memory_mib > 4096 or args.cpus < 1 or args.cpus > 16 or args.timeout <= 0:
        parser.error("memory must be 128..4096 MiB, cpus 1..16, timeout positive")
    if args.init_outcome != "exited" and not args.init:
        parser.error("--init-outcome requires --init")
    if args.init_outcome == "fault" and (args.expected_fault_vector is None or
                                       not 0 <= args.expected_fault_vector < 32):
        parser.error("--init-outcome fault requires --expected-fault-vector in 0..31")
    if args.init_outcome != "fault" and any(value is not None for value in
                                          (args.expected_fault_vector, args.expected_fault_error,
                                           args.expected_fault_address)):
        parser.error("--expected-fault-* requires --init-outcome fault")
    if args.require_call_stack_preemption and (not args.init or args.init_outcome != "limited"):
        parser.error("--require-call-stack-preemption requires --init and --init-outcome limited")

    work = args.out or tempfile.mkdtemp(prefix="swypik-qemu-boot-")
    os.makedirs(work, exist_ok=True)
    esp = os.path.join(work, "esp")
    os.makedirs(os.path.join(esp, "EFI", "BOOT"), exist_ok=True)
    shutil.copyfile(args.efi, os.path.join(esp, "EFI", "BOOT", "BOOTX64.EFI"))
    init_dir = os.path.join(esp, "EFI", "SWYPIK")
    if args.init:
        os.makedirs(init_dir, exist_ok=True)
        shutil.copyfile(args.init, os.path.join(init_dir, "INIT.SWD"))
    elif os.path.exists(os.path.join(init_dir, "INIT.SWD")):
        raise ValueError("output ESP already contains INIT.SWD; choose a fresh --out directory")
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
    cmd += ["-machine", machine, "-accel", "tcg", "-cpu", args.cpu, "-smp", str(args.cpus),
           "-m", str(args.memory_mib), "-display", "none", "-no-reboot", "-net", "none",
           "-drive", f"if=pflash,format=raw,readonly=on,file={args.ovmf_code}",
           "-drive", f"if=pflash,format=raw,file={vars_copy}",
           "-drive", f"format=raw,file=fat:rw:{esp}",
           "-serial", f"file:{serial}", "-monitor", f"unix:{mon},server,nowait",
           "-d", "cpu_reset,guest_errors" + (",int" if args.trace_interrupts or args.require_call_stack_preemption else ""), "-D", qlog]
    if args.iommu:
        cmd += ["-device", "intel-iommu,intremap=on"]
    started = time.monotonic()
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    result = {"efi": os.path.abspath(args.efi), "machine": machine, "cpus": args.cpus,
              "memory_mib": args.memory_mib, "cpu": args.cpu, "accel": "tcg", "evidence": work}
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
            if not os.path.exists(dump) or os.path.getsize(dump) != args.memory_mib * 1024 * 1024:
                raise RuntimeError(f"pmemsave produced no complete dump; monitor replied: {reply!r}")
            with open(dump, "rb") as stream:
                ram = stream.read()
            os.remove(dump)
            result["boot_info"] = boot_info_candidates(ram)
            monitor(mon, "quit")
        proc.wait(timeout=30)
        result["qemu_output"] = proc.stdout.read(4096).decode(errors="replace")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    with open(qlog, "r", errors="replace") as stream:
        log = stream.read()
    result["cpu_resets_logged"] = log.count("CPU Reset")
    result["guest_errors"] = [line for line in log.splitlines() if "guest_errors" in line or "invalid" in line.lower()][:10]
    if args.require_call_stack_preemption:
        result["user_timer"] = user_timer_evidence(log)
    serial_text_final = ""
    try:
        with open(serial, "rb") as stream:
            serial_text_final = stream.read().decode("utf-8", errors="replace")
    except OSError:
        pass
    result["serial_tail"] = serial_text_final[-600:]
    # Post-handoff proof: the live SwypBootInfo has the firmware table cleared
    # after ExitBootServices. Multiple plausible live records are ambiguous,
    # never a reason to select whichever has the most favorable flags.
    live = [c for c in result.get("boot_info", []) if c["firmware_system_table"] == "0x0"]
    best = live[0] if len(live) == 1 else None
    result["live_boot_info"] = best
    flags = int(best["boot_flags"], 16) if best else 0
    checks = {
        "serial_banner_and_handoff": result["serial_lines_seen"] == BANNER,
        "no_reset_or_triple_fault": result["qemu_alive"],
        "vcpu_halted": result["halted"],
        "exited_boot_services": bool(flags & 1),
        "runtime_handoff_reached": flags & REQUIRED_RUNTIME == REQUIRED_RUNTIME,
        "runtime_handoff_validated": bool(flags & (1 << 17)),
    }
    init = (best or {}).get("init", {})
    if args.require_call_stack_preemption:
        timer = result["user_timer"]
        checks["called_stack_preempted"] = timer["rsp_mod16_8"] > 0
        checks["repeated_user_timer_and_if"] = (timer["count"] >= 2 and
                                               timer["count"] >= init.get("preemptions", 0) and
                                               timer["if_enabled"] == timer["count"])
    if args.init_outcome != "fault":
        checks["no_unexpected_task_fault"] = not flags & (1 << 18) and not any(init.get("fault", {}).values())
    if not args.init:
        checks["no_implicit_init"] = flags & (((1 << 17) - 1) ^ ((1 << 11) - 1)) == 0
    elif args.init_outcome == "refused":
        checks["invalid_init_refused"] = bool(flags & (1 << 12)) and not flags & ((1 << 11) | (1 << 13) | (1 << 14))
        checks["refusal_reason_recorded"] = init.get("status", 0) != 0
    elif args.init_outcome == "limited":
        checks["init_preempted_and_limited"] = init.get("preemptions", 0) > 0 and init.get("status") != 0
        checks["limited_init_dispatch_bound"] = (init.get("preemptions", 0) + init.get("yields", 0) == 128 and
                                                 init.get("status") == -4)
        checks["limited_init_cleaned"] = bool(flags & (1 << 15)) and bool(flags & (1 << 16)) and not flags & (1 << 14)
    elif args.init_outcome == "fault":
        checks.update(expected_fault_checks(flags, init, int(result["cr3"], 16) if result["cr3"] else 0,
                                            args.expected_fault_vector, args.expected_fault_error,
                                            args.expected_fault_address))
    else:
        checks["init_executed"] = flags & ((1 << 11) | (1 << 13) | (1 << 14) | (1 << 15)) == (
            (1 << 11) | (1 << 13) | (1 << 14) | (1 << 15))
        checks["init_succeeded"] = (init.get("status") == 0 and init.get("exit_code") == args.expected_exit and
                                   not flags & ((1 << 12) | (1 << 16)))
        checks["init_domain_isolated"] = init.get("observed_domain") == 1
    result["checks"] = checks
    result["status"] = "PASS" if all(checks.values()) else "FAIL"
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
