"""Regression cases: a matching commit alone must never pass a deployment gate."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "infra/azure/node/verify-release-health.py"


class ReleaseHealthTests(unittest.TestCase):
    def check(self, body, expected):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "expected-commit"],
            input=json.dumps(body), text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, expected)
        self.assertEqual(result.stdout, "")

    def healthy(self):
        return {"status": "healthy", "release": {"commit": "expected-commit"},
                "services": {"database": "ok", "redis": "ok", "storage": {"ok": True}}}

    def test_current_healthy_release_passes(self):
        self.check(self.healthy(), 0)

    def test_matching_commit_with_failed_database_is_rejected(self):
        body = self.healthy()
        body["status"] = "degraded"
        body["services"]["database"] = "error"
        self.check(body, 1)

    def test_unhealthy_dependencies_are_rejected_even_if_top_level_is_healthy(self):
        for name, value in [("database", "error"), ("redis", "error"), ("storage", {"ok": False})]:
            with self.subTest(name=name):
                body = self.healthy()
                body["services"][name] = value
                self.check(body, 1)

    def test_commit_must_match_exactly(self):
        body = self.healthy()
        body["release"]["commit"] = "expected-commit-but-different"
        self.check(body, 1)

    def test_malformed_response_is_rejected(self):
        for body in [None, [], {}, {"release": None}, {"status": "healthy", "release": []}]:
            self.check(body, 1)
        result = subprocess.run([sys.executable, str(SCRIPT), "expected-commit"],
                                input="<html>expected-commit</html>", text=True, capture_output=True)
        self.assertEqual(result.returncode, 1)


if __name__ == "__main__":
    unittest.main()
