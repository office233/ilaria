import copy
import importlib.util
import struct
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("boot_qemu", Path(__file__).resolve().parents[1] / "boot-qemu.py")
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


class BootEvidenceTests(unittest.TestCase):
    def record(self, size=320, abi=1):
        data = bytearray(size)
        struct.pack_into("<QII", data, 0, harness.MAGIC, abi, size)
        return data

    def test_known_prefixes_and_fault_layout(self):
        for size in (168, 232, 320):
            with self.subTest(size=size):
                data = self.record(size)
                if size == 320:
                    struct.pack_into("<II9QiI", data, 232, 1, 88, 1, 1, 1, 14, 5,
                                     0xFFFFC00000001000, 0x400000, 0x23, 0x100000, -8, 0)
                decoded = harness.boot_info_candidates(data)
                self.assertEqual(len(decoded), 1)
                self.assertEqual(decoded[0]["struct_size"], size)
                if size == 320:
                    self.assertEqual(decoded[0]["init"]["fault"]["status"], -8)
                    self.assertEqual(decoded[0]["init"]["fault"]["address"], 0xFFFFC00000001000)

    def test_unknown_version_size_and_truncation_are_not_decoded(self):
        for data in (self.record(320, 2), self.record(240), self.record()[:-1]):
            self.assertEqual(harness.boot_info_candidates(data), [])

    def test_user_timer_trace_requires_real_user_stack_and_saved_if(self):
        log = """  1: v=e0 e=0000 i=0 cpl=0 IP=0008:0010 SP=0010:0020
RIP=0010 RFL=00000002
  2: v=e0 e=0000 i=0 cpl=3 IP=0023:0040 SP=001b:00f8
RAX=0
RIP=0040 RFL=00000202
  3: v=e0 e=0000 i=0 cpl=3 IP=0023:0041 SP=001b:00f0
RIP=0041 RFL=00000002
"""
        evidence = harness.user_timer_evidence(log)
        self.assertEqual(evidence["count"], 2)
        self.assertEqual(evidence["rsp_mod16_8"], 1)
        self.assertEqual(evidence["if_enabled"], 1)
        self.assertEqual(harness.user_timer_evidence(""), {
            "count": 0, "rsp_mod16_8": 0, "if_enabled": 0, "examples": []})

    def test_fault_requires_cleanup_failure_status_and_final_handoff(self):
        flags = sum(1 << bit for bit in (11, 15, 16, 17, 18))
        init = {"status": -8, "exit_code": 0, "fault": {
            "version": 1, "struct_size": 88, "thread_id": 1, "domain_id": 1, "lease_fence": 1,
            "vector": 6, "error_code": 0, "address": 0, "rip": 0x400000, "cs": 0x23,
            "kernel_cr3": 0x100000, "status": -8, "reserved": 0}}

        def passing(bits=flags, evidence=init, cr3=0x100000):
            return all(harness.expected_fault_checks(bits, evidence, cr3, 6, 0, 0).values())

        self.assertTrue(passing())
        for bit in (11, 15, 16, 17, 18):
            self.assertFalse(passing(flags & ~(1 << bit)))
        for bit in (12, 14):
            self.assertFalse(passing(flags | (1 << bit)))
        self.assertFalse(passing(evidence={"status": -8, "exit_code": 0}))
        self.assertFalse(passing(cr3=0x200000))
        for field, value in (("version", 2), ("struct_size", 80), ("thread_id", 2), ("domain_id", 2),
                             ("lease_fence", 2), ("cs", 8), ("status", 0), ("vector", 13), ("address", 1)):
            modified = copy.deepcopy(init)
            modified["fault"][field] = value
            self.assertFalse(passing(evidence=modified), field)
        for field, value in (("status", 0), ("exit_code", 42)):
            modified = copy.deepcopy(init)
            modified[field] = value
            self.assertFalse(passing(evidence=modified), field)


if __name__ == "__main__":
    unittest.main()
