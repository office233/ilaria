# -*- coding: utf-8 -*-
"""P1 - Creator: setari profil (fiecare camp) + upload clipuri. Re-rulabil."""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, sql, shot, login, Journal, dismiss_overlays, new_ctx

EMAIL = "creator@swypik.test"
MEDIA = r"C:\Users\Pos5\AppData\Local\Temp\opencode\qa-media"
J = Journal("P1")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = new_ctx(browser)
    page = ctx.new_page()
    api_fails = []
    page.on("response", lambda r: api_fails.append((r.status, r.url, r.request.method))
            if r.status >= 400 and "/api/" in r.url else None)
    ok = login(page, EMAIL)
    J.log("login", "PASS" if ok else "FAIL", page.url)

    # ===== SETARI PROFIL /ro/account/edit =====
    page.goto(BASE + "/ro/account/edit", wait_until="domcontentloaded", timeout=45000)
    dismiss_overlays(page)
    shot(page, "P1", "10-account-edit-initial")
    body = page.inner_text("body")
    J.log("pagina setari se deschide", "FAIL" if ("500" in body[:50] or len(body) < 100) else "PASS",
          f"len={len(body)}")

    # nume afisat + bio cu emoji/diacritice
    BIO = "Bio de test cu diacritice ăâîșț și emoji 🎬🚀"
    NAME = "Creator Țest Îmi"
    try:
        inputs = page.locator("#edit-profile-form input[type=text], form input[type=text]")
        page.fill('input[placeholder*="ume"], #edit-profile-form input >> nth=0', NAME)
    except Exception:
        pass
    # gaseste generic: primul text input = nume
    tin = page.locator('form input[type="text"]').all()
    if tin:
        tin[0].fill(NAME)
    ta = page.locator("form textarea").first
    if ta.count():
        ta.fill(BIO)
    # avatar JPG
    fi = page.locator('input[type="file"]').first
    if fi.count():
        fi.set_input_files(os.path.join(MEDIA, "avatar.jpg"))
        page.wait_for_timeout(3000)
    shot(page, "P1", "11-account-edit-completat")
    # submit (dupa dismiss modal onboarding care poate reaparea)
    dismiss_overlays(page)
    page.wait_for_timeout(500)
    dismiss_overlays(page)
    sub = page.locator('button[type="submit"][form="edit-profile-form"]').first
    if not sub.count():
        sub = page.locator('form button[type="submit"]').first
    try:
        sub.click(timeout=8000)
    except Exception:
        # BUG UX (mobil 390x844): bottom-nav (data-testid=bottom-nav) acopera butonul Salvează
        J.log("buton Salveaza acoperit de bottom-nav (mobil)", "FAIL",
              "bottom-nav intercepteaza click pe butonul Salvează la 390x844 — click posibil doar programatic")
        sub.evaluate("el => el.click()")
    page.wait_for_timeout(4000)
    shot(page, "P1", "12-account-edit-dupa-salvare")
    # refresh hard
    page.goto(BASE + "/ro/account/edit", wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(1500)
    shot(page, "P1", "13-account-edit-dupa-refresh")
    body2 = page.inner_text("body")
    persisted = NAME in body2 or NAME in page.content()
    bio_persisted = "ăâîșț" in page.content()
    J.log("nume afisat persista dupa F5", "PASS" if persisted else "FAIL", f"'{NAME}' in pagina: {persisted}")
    J.log("bio cu diacritice+emoji persista", "PASS" if bio_persisted else "FAIL", f"{bio_persisted}")
    out, _ = sql(f"SELECT display_name, substring(coalesce(bio,'') for 60), avatar_url IS NOT NULL FROM users WHERE email='{EMAIL}'")
    J.log("DB confirma profil", "PASS" if NAME in out else "FAIL", f"db={out!r}")

    # avatar mare 45MB PNG
    page.goto(BASE + "/ro/account/edit", wait_until="domcontentloaded", timeout=45000)
    dismiss_overlays(page)
    fi = page.locator('input[type="file"]').first
    if fi.count():
        fi.set_input_files(os.path.join(MEDIA, "avatar_big.png"))
        page.wait_for_timeout(6000)
        shot(page, "P1", "14-avatar-8mb-plus")
        J.log("avatar PNG 45MB", "INFO", f"api_fails_recente={api_fails[-3:]}")

    # ===== UPLOAD CLIP /ro/upload =====
    def try_upload(fname, label, title):
        api_fails.clear()
        page.goto(BASE + "/ro/upload", wait_until="domcontentloaded", timeout=45000)
        dismiss_overlays(page)
        shot(page, "P1", f"20-upload-{label}-pagina")
        fi = page.locator('input[type="file"]').first
        if not fi.count():
            J.log(f"upload {label}: pagina", "FAIL", "nu exista input file pe /ro/upload — " + page.inner_text("body")[:120])
            return
        fi.set_input_files(os.path.join(MEDIA, fname))
        page.wait_for_timeout(4000)
        shot(page, "P1", f"21-upload-{label}-selectat")
        # completeaza titlu daca exista
        for sel in ['input[placeholder*="itlu"]', 'input[name*="title"]', "form input[type=text]"]:
            el = page.locator(sel).first
            if el.count():
                try:
                    el.fill(title); break
                except Exception:
                    pass
        # submit
        for name in ["Publică", "Încarcă", "Upload", "Postează"]:
            btn = page.get_by_role("button", name=name)
            if btn.count():
                btn.first.click(); break
        else:
            sb = page.locator('button[type="submit"]').first
            if sb.count(): sb.click()
        # asteapta pana la 120s progres
        for i in range(24):
            page.wait_for_timeout(5000)
            b = page.inner_text("body")
            if any(w in b for w in ["Publicat", "procesare", "Processing", "succes", "Gata"]):
                break
        shot(page, "P1", f"22-upload-{label}-final")
        J.log(f"upload {label}", "INFO", f"body={page.inner_text('body')[:150]!r} api_fails={api_fails[:5]}")

    try_upload("clip_portrait_15s.mp4", "portrait15s", "Clip test portrait ăâî 🎬")
    try_upload("clip_test.mov", "mov", "Clip test MOV")
    try_upload("fake_video.mp4", "fake-txt", "Fals video txt")

    out, _ = sql("SELECT id, title, status FROM videos v JOIN creators c ON v.creator_id=c.id JOIN users u ON c.user_id=u.id WHERE u.email='creator@swypik.test' ORDER BY v.created_at DESC LIMIT 10")
    J.log("videos in DB", "INFO", out or "niciun video")

    with open(os.path.join(os.path.dirname(__file__), "..", "evidence", "P1", "_api_fails.json"), "w", encoding="utf-8") as f:
        json.dump(api_fails, f, indent=2)
    browser.close()

J.dump()
