import importlib.util
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

GENERATOR = Path(__file__).resolve().parents[1] / "tools" / "make-init-image.py"
spec = importlib.util.spec_from_file_location("make_init_image", GENERATOR)
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


class InitImageTests(unittest.TestCase):
    def test_reproducible_single_read_execute_segment(self):
        image = generator.build_image()
        self.assertEqual(image, generator.build_image())
        self.assertEqual(struct.unpack_from("<8sHHH", image), (b"SWYDRV1\0", 1, 64, 1))
        self.assertEqual(struct.unpack_from("<QQ", image, 24), (0, 4096))
        segment = struct.unpack_from("<6Q", image, 64)
        self.assertEqual(segment, (0, 256, len(image) - 256, 4096, 5, 0))
        self.assertIn(bytes.fromhex("66 8c c8 83 e0 03 83 f8 03"), image[256:])
        self.assertIn(bytes.fromhex("b8 04 00 00 00 cd 80"), image[256:])
        self.assertIn(bytes.fromhex("bf 2a 00 00 00 b8 05 00 00 00 cd 80"), image[256:])

    def test_loop_is_explicit_and_retains_yield(self):
        image = generator.build_image("loop")
        self.assertIn(bytes.fromhex("b8 04 00 00 00 cd 80 eb fe"), image[256:])
        self.assertNotEqual(image, generator.build_image("success"))

    def test_invalid_mode_is_refused(self):
        with self.assertRaises(ValueError):
            generator.build_image("invalid")

    def test_cli_does_not_overwrite_an_existing_image(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "init.swd"
            first = subprocess.run([sys.executable, str(GENERATOR), str(target)], capture_output=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            original = target.read_bytes()
            second = subprocess.run([sys.executable, str(GENERATOR), "--mode", "loop", str(target)], capture_output=True)
            self.assertNotEqual(second.returncode, 0)
            self.assertEqual(target.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
