"""Run the actual preflight with synthetic credentials, never production env files."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "infra/azure/preflight.sh"


@unittest.skipIf(os.name == "nt" or not shutil.which("bash"), "Run shell checks in Linux/WSL")
class PreflightTests(unittest.TestCase):
    def fixture(self):
        env = {
            "DATABASE_URL": "postgres://swypik:fixture-secret@10.60.2.10:5432/swypik_prod",
            "REDIS_URL": "redis://:fixture-secret@10.60.2.10:6379/0",
            "NEXT_PUBLIC_APP_URL": "https://staging.example.test",
            "APP_ENCRYPTION_KEY": "a" * 64,
            "EMAIL_FROM": "audit@example.test", "RESEND_API_KEY": "re_fixture",
            "STRIPE_SECRET_KEY": "sk_test_fixture", "STRIPE_WEBHOOK_SECRET": "whsec_fixture",
            "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY": "pk_test_fixture",
            "S3_ENDPOINT": "https://fixture.r2.cloudflarestorage.com", "S3_ACCESS_KEY": "fixture",
            "S3_SECRET_KEY": "fixture", "S3_BUCKET": "fixture", "S3_PUBLIC_URL": "https://media.example.test",
            "AZURE_OPENAI_ENDPOINT": "https://fixture.openai.azure.com", "AZURE_OPENAI_API_KEY": "fixture",
            "AZURE_OPENAI_CHAT_DEPLOYMENT": "fixture", "AZURE_OPENAI_WHISPER_DEPLOYMENT": "fixture",
            "AZURE_CONTENT_SAFETY_ENDPOINT": "https://fixture.cognitiveservices.azure.com",
            "AZURE_CONTENT_SAFETY_KEY": "fixture",
        }
        for key in ["CRON_SECRET", "ADMIN_SECRET", "PLATFORM_API_SECRET", "FEED_EVENT_IP_SALT"]:
            env[key] = "b" * 40
        return env

    def run_preflight(self, env):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "fixture.env"
            path.write_text("".join(f"{k}={v}\n" for k, v in env.items()))
            path.chmod(0o600)
            return subprocess.run(["bash", str(SCRIPT), "--env", str(path)], capture_output=True, text=True)

    def test_complete_synthetic_configuration_passes(self):
        result = self.run_preflight(self.fixture())
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_native_data_role_does_not_require_retired_erp_password(self):
        env = self.fixture()
        secret = "synthetic-test-secret-0123456789012345"
        env["DATABASE_URL"] = env["DATABASE_URL"].replace("fixture-secret", secret)
        env["REDIS_URL"] = env["REDIS_URL"].replace("fixture-secret", secret)
        data = {"DATA_BIND_IP": "10.60.2.10", "POSTGRES_DB": "swypik_prod",
                "POSTGRES_USER": "swypik", "POSTGRES_PASSWORD": secret, "REDIS_PASSWORD": secret}
        with tempfile.TemporaryDirectory() as tmp:
            app_path, data_path = Path(tmp) / "app.env", Path(tmp) / "data.env"
            for path, values in ((app_path, env), (data_path, data)):
                path.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
                path.chmod(0o600)
            result = subprocess.run(["bash", str(SCRIPT), "--env", str(app_path),
                                     "--data-env", str(data_path)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_retired_multi_erp_keys_only_warn(self):
        env = self.fixture()
        env["INTERNAL_SECRET"] = "c" * 40
        env["PARTNER_PROVISION_SECRET"] = "d" * 40
        result = self.run_preflight(env)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("Multi-ERP retras", result.stdout)
        self.assertNotIn(env["INTERNAL_SECRET"], result.stdout + result.stderr)

    def test_payment_placeholder_is_rejected_without_leaking_value(self):
        env = self.fixture()
        env["STRIPE_SECRET_KEY"] = "sk_live_placeholder_DO_NOT_PRINT"
        result = self.run_preflight(env)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(env["STRIPE_SECRET_KEY"], result.stdout + result.stderr)
        self.assertIn("conține un placeholder", result.stdout)

    def test_email_placeholder_cannot_satisfy_transport_requirement(self):
        env = self.fixture()
        env["RESEND_API_KEY"] = "re_placeholder_DO_NOT_PRINT"
        result = self.run_preflight(env)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(env["RESEND_API_KEY"], result.stdout + result.stderr)

    def test_smtp_can_replace_an_unconfigured_resend_provider(self):
        env = self.fixture()
        env["RESEND_API_KEY"] = "re_placeholder"
        env["SMTP_HOST"] = "smtp.example.test"
        result = self.run_preflight(env)
        self.assertEqual(result.returncode, 0, result.stdout)


if __name__ == "__main__":
    unittest.main()
