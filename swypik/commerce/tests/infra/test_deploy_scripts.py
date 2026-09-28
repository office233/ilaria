"""deploy.sh helpers: migrations run atomically with the ledger, DB URL never in argv,
image tags pinned, build before migrations."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
AZ = ROOT / "infra/azure"
BASH = shutil.which("bash")


class PgEnvFromUrlTests(unittest.TestCase):
    def run_script(self, url):
        env = dict(os.environ, DBURL=url)
        return subprocess.run([sys.executable, str(AZ / "node/pg-env-from-url.py")],
                              env=env, text=True, encoding="utf-8", errors="replace", capture_output=True)

    def test_parses_url_into_pg_variables(self):
        r = self.run_script("postgresql://swypik:p%40ss'w@10.60.2.10:5433/swypik_prod?sslmode=disable")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("export PGHOST=10.60.2.10", r.stdout)
        self.assertIn("export PGPORT=5433", r.stdout)
        self.assertIn("export PGUSER=swypik", r.stdout)
        self.assertIn("export PGDATABASE=swypik_prod", r.stdout)
        self.assertIn("export PGSSLMODE=disable", r.stdout)
        # password decoded and shell-quoted
        self.assertIn("PGPASSWORD='p@ss'\"'\"'w'", r.stdout)

    def test_rejects_missing_or_foreign_url(self):
        self.assertNotEqual(self.run_script("").returncode, 0)
        self.assertNotEqual(self.run_script("mysql://a:b@h/db").returncode, 0)


@unittest.skipIf(BASH is None, "bash lipsește")
class MigrationTxTests(unittest.TestCase):
    def render(self, sql, version="20260928_0070_test"):
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as f:
            f.write(sql)
            path = f.name
        try:
            return subprocess.run([BASH, str(AZ / "node/migration-tx.sh"), path, version],
                                  text=True, encoding="utf-8", errors="replace", capture_output=True)
        finally:
            os.unlink(path)

    def test_wraps_file_and_ledger_in_one_transaction(self):
        r = self.render("BEGIN;\nCREATE TABLE IF NOT EXISTS t (id int);\nCOMMIT;\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = [l for l in r.stdout.splitlines() if l.strip()]
        self.assertEqual(lines[0], "BEGIN;")
        self.assertEqual(lines[-1], "COMMIT;")
        self.assertEqual(sum(1 for l in lines if l.strip().upper() in ("BEGIN;", "COMMIT;")), 2)
        ledger = lines.index("INSERT INTO schema_migrations (version) VALUES ('20260928_0070_test') ON CONFLICT DO NOTHING;")
        self.assertEqual(ledger, len(lines) - 2)

    def test_keeps_plpgsql_blocks_intact(self):
        sql = "DO $$\nBEGIN\n  PERFORM 1;\nEND;\n$$;\n"
        r = self.render(sql)
        self.assertIn("BEGIN\n  PERFORM 1;\nEND;\n$$;", r.stdout)

    def test_refuses_concurrently_and_bad_versions(self):
        self.assertEqual(self.render("CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (id);").returncode, 3)
        self.assertEqual(self.render("-- CONCURRENTLY only in a comment\nSELECT 1;").returncode, 0)
        self.assertEqual(self.render("SELECT 1;", version="x'); DROP TABLE users; --").returncode, 2)


class DeployOrderTests(unittest.TestCase):
    def setUp(self):
        self.src = (AZ / "deploy.sh").read_text(encoding="utf-8")

    def test_build_runs_before_backup_and_migrations(self):
        build = self.src.index('log "5. build')
        backup = self.src.index('log "6. backup DB')
        migrate = self.src.index('log "7. migrări')
        self.assertLess(build, backup)
        self.assertLess(backup, migrate)

    def test_db_url_is_not_passed_in_argv(self):
        self.assertNotIn('-d "$DBURL"', self.src)
        self.assertIn("migration-tx.sh", self.src)

    def test_flags_do_not_touch_live_env_before_success(self):
        flags = self.src[self.src.index('log "2. flag-uri'):self.src.index('log "3. preflight')]
        self.assertNotIn("$ENV_FILE", flags)


class ComposeTagTests(unittest.TestCase):
    def test_no_latest_default_and_never_pull(self):
        for name in ("web.yml", "worker.yml"):
            src = (AZ / "compose" / name).read_text(encoding="utf-8")
            self.assertNotIn(":-latest", src, name)
            images = re.findall(r"^\s+image: .*SWYPIK_IMAGE_TAG.*$", src, re.M)
            self.assertTrue(images, name)
            for line in images:
                self.assertIn("SWYPIK_IMAGE_TAG:?", line)
            self.assertEqual(src.count("pull_policy: never"), src.count("image:"), name)

    def test_dispatch_worker_on_control_node(self):
        src = (AZ / "compose/web.yml").read_text(encoding="utf-8")
        block = src[src.index("  dispatch-worker:"):]
        self.assertIn("profiles: [cron]", block)
        self.assertIn("dispatch-worker.mjs", block)
        self.assertIn("/api/cron/dispatch-tick", block)


if __name__ == "__main__":
    unittest.main()
