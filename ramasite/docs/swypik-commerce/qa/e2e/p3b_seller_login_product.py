# -*- coding: utf-8 -*-
"""P3b - Login seller prin OTP + adaugare produs prin AddProductWizard.
NOTA mediu QA: OTP-ul se trimite pe email (seller@swypik.test - inbox inexistent).
In prod build OTP-ul NU apare in log. Incercam totusi logul (dev fallback);
daca OTP nu e recuperabil -> BUG BLOCANT DE MEDIU documentat, testam mai departe doar UI-ul."""
import os, sys, re, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, sql, shot, Journal, dismiss_overlays, new_ctx

J = Journal("P3")
EMAIL = "seller@swypik.test"

def docker_log_otp():
    script = r"\\wsl.localhost\swypik\tmp\qa_otp.sh"
    with open(script, "w", newline="\n") as f:
        f.write('docker logs swypik-prod-web-next-1 --since 5m 2>&1 | grep -iE "otp|magic|token" | tail -n 10\n')
    r = subprocess.run(["wsl", "-d", "swypik", "-e", "bash", "/tmp/qa_otp.sh"],
                       capture_output=True, text=True, stdin=subprocess.DEVNULL)
    m = re.findall(r"\b(\d{6})\b", r.stdout)
    return (m[-1] if m else None), r.stdout.strip()[:400]

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = new_ctx(b, mobile=False)
    pg = ctx.new_page()

    pg.goto(BASE + "/seller/login", wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(2000); dismiss_overlays(pg)
    shot(pg, "P3", "10-seller-login")
    if pg.locator("#email").count() == 0:
        J.log("pagina /seller/login", "FAIL", "fara camp #email: " + pg.inner_text("body")[:150])
        b.close(); J.dump(); sys.exit(0)

    pg.fill("#email", EMAIL)
    pg.locator('button[type="submit"]').first.click()
    pg.wait_for_timeout(4000)
    shot(pg, "P3", "11-seller-otp-cerut")
    has_otp_field = pg.locator("#otp").count() > 0
    J.log("cerere OTP seller", "PASS" if has_otp_field else "FAIL",
          pg.inner_text("body")[:130].replace("\n", "|"))

    otp, logtxt = docker_log_otp()
    if not otp:
        J.log("OTP recuperabil in mediul de test", "FAIL",
              "OTP trimis doar pe email real (app/api/seller/auth/route.ts:83-84 - log doar in dev). "
              "BLOCANT PENTRU TESTARE LOCALA: sellerul de test nu se poate loga fara inbox. log=" + logtxt[:200])
        b.close(); J.dump(); sys.exit(0)

    pg.fill("#otp", otp)
    pg.locator('button[type="submit"]').first.click()
    pg.wait_for_timeout(4000)
    shot(pg, "P3", "12-seller-dupa-otp")
    J.log("login seller", "PASS" if "/seller" in pg.url and "login" not in pg.url else "FAIL", pg.url)

    # adaugare produs
    pg.goto(BASE + "/seller/products", wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(2500); dismiss_overlays(pg)
    shot(pg, "P3", "13-seller-products")
    J.log("pagina seller/products", "INFO", pg.inner_text("body")[:150].replace("\n", "|"))
    b.close()

J.dump()