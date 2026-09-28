# -*- coding: utf-8 -*-
"""P3 - Seller: aplicare, aprobare admin (UI), login seller, adaugare produs. + P7 partial admin."""
import os, sys, re, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, sql, shot, login, Journal, dismiss_overlays, new_ctx

J = Journal("P3")

def admin_secret():
    r = subprocess.run(["wsl", "-d", "swypik", "-e", "bash", "-lc",
                        "grep '^ADMIN_SECRET=' /opt/swypik/app/infra/hetzner/.env.production | cut -d= -f2-"],
                       capture_output=True, text=True, stdin=subprocess.DEVNULL)
    return r.stdout.strip()

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = new_ctx(b); pg = ctx.new_page()

    # 1. aplicare seller din UI public
    out, _ = sql("SELECT id,status FROM sellers WHERE email='seller@swypik.test'")
    if not out:
        pg.goto(BASE + "/ro/become-a-seller", wait_until="domcontentloaded", timeout=45000)
        pg.wait_for_timeout(2500); dismiss_overlays(pg)
        shot(pg, "P3", "01-become-a-seller")
        pg.fill('input[name="companyName"]', "Vânzătorul de Țest SRL")
        pg.fill('input[name="cui"]', "RO12345678")
        pg.fill('input[name="email"]', "seller@swypik.test")
        pg.fill('input[name="phone"]', "0733111222")
        pg.fill('textarea[name="productType"]', "Electronice și accesorii de test QA")
        shot(pg, "P3", "02-formular-completat")
        sub = pg.get_by_role("button", name="Trimite Aplicația")
        try: sub.first.click(timeout=5000)
        except Exception: sub.first.evaluate("el=>el.click()")
        pg.wait_for_timeout(4000)
        shot(pg, "P3", "03-dupa-submit")
        out, _ = sql("SELECT id,status FROM sellers WHERE email='seller@swypik.test'")
    J.log("aplicare seller in DB", "PASS" if out else "FAIL", out or pg.inner_text("body")[:150])

    # 2. login ADMIN + aprobare din UI
    a = new_ctx(b, mobile=False); ap = a.new_page()
    ap.goto(BASE + "/admin", wait_until="domcontentloaded", timeout=45000)
    ap.wait_for_timeout(2000)
    shot(ap, "P7", "01-admin-login")
    sec = admin_secret()
    pwd = ap.locator('input[type="password"], input[type="text"]').first
    if pwd.count():
        pwd.fill(sec)
        sb = ap.locator('button[type="submit"]').first
        (sb if sb.count() else ap.locator("button").first).click()
        ap.wait_for_timeout(3500)
    shot(ap, "P7", "02-admin-dupa-login")
    J.log("login admin", "PASS" if "/admin" in ap.url and "login" not in ap.url else "INFO", ap.url)

    ap.goto(BASE + "/admin/sellers", wait_until="domcontentloaded", timeout=45000)
    ap.wait_for_timeout(2500)
    shot(ap, "P7", "03-admin-sellers")
    body = ap.inner_text("body")
    J.log("admin/sellers listeaza aplicantul", "PASS" if "swypik.test" in body or "Țest" in body else "FAIL", body[:200])
    apr = ap.get_by_role("button", name=re.compile("Aprob|Approve"))
    if apr.count():
        apr.first.click(); ap.wait_for_timeout(3000)
        shot(ap, "P7", "04-dupa-aprobare")
    out2, _ = sql("SELECT status FROM sellers WHERE email='seller@swypik.test'")
    J.log("seller aprobat din UI admin", "PASS" if out2 == "approved" else "FAIL", f"status={out2}")

    # 3. panouri admin — smoke
    for path in ["/admin/orders", "/admin/users", "/admin/merchants", "/admin/fleet",
                 "/admin/payouts", "/admin/moderation", "/admin/creators", "/admin/health"]:
        resp = ap.goto(BASE + path, wait_until="domcontentloaded", timeout=45000)
        ap.wait_for_timeout(1500)
        nm = path.strip("/").replace("/", "-")
        shot(ap, "P7", f"10-{nm}")
        txt = ap.inner_text("body")[:100]
        bad = resp.status >= 500 or "Application error" in txt
        J.log(f"panel {path}", "FAIL" if bad else "PASS", f"status={resp.status}")

    b.close()
J.dump()
