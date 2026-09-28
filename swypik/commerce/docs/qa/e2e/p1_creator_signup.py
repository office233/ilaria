# -*- coding: utf-8 -*-
"""P1 - Creator: signup, onboarding, setari, upload clip. Re-rulabil (email cu timestamp la nevoie)."""
import os, sys, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, PASSWORD, sql, shot, signup, login, Journal, EVID

EMAIL = "creator@swypik.test"
J = Journal("P1")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    errs = []
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)

    # exista deja contul?
    out, _ = sql(f"SELECT id,email FROM users WHERE email='{EMAIL}'")
    if out:
        ok = login(page, EMAIL)
        J.log("login cont existent", "PASS" if ok else "FAIL", f"url={page.url}")
    else:
        # validari: email invalid
        page.goto(BASE + "/auth/signup", wait_until="networkidle")
        page.fill('input[type="email"]', "nu-e-email")
        page.keyboard.press("Enter")
        page.wait_for_timeout(1200)
        shot(page, "P1", "01-signup-email-invalid")
        J.log("validare email invalid", "PASS" if "/auth/signup" in page.url else "FAIL",
              f"ramane pe pagina: {page.url}")
        ok = signup(page, EMAIL, "Creator", "Test", "creator_test")
        shot(page, "P1", "02-signup-final")
        J.log("signup creator", "PASS" if ok else "FAIL", f"url final={page.url}")

    out, _ = sql(f"SELECT id FROM users WHERE email='{EMAIL}'")
    J.log("user in DB", "PASS" if out else "FAIL", f"id={out}")
    uid = out.split("|")[0] if out else None

    # stare sesiune
    page.goto(BASE + "/", wait_until="networkidle")
    shot(page, "P1", "03-home-logat")

    # onboarding creator
    page.goto(BASE + "/creator", wait_until="networkidle")
    shot(page, "P1", "04-creator-page")
    J.log("pagina /creator", "INFO", f"url={page.url} text={page.inner_text('body')[:150]!r}")

    ctx.storage_state(path=os.path.join(EVID, "P1", "_state.json"))
    with open(os.path.join(EVID, "P1", "_console.json"), "w", encoding="utf-8") as f:
        json.dump(errs, f, indent=2, ensure_ascii=False)
    browser.close()

J.dump()
