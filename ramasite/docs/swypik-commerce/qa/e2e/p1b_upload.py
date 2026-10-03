# -*- coding: utf-8 -*-
"""P1b - Upload video creator, pas cu pas, cu debug UI."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, login, new_ctx, dismiss_overlays, shot, sql, Journal

MEDIA = r"C:\Users\Pos5\AppData\Local\Temp\opencode\qa-media"
J = Journal("P1")

def run_upload(pg, fname, label, title):
    fails = []
    pg.on("response", lambda r: fails.append((r.status, r.url[:100], r.request.method)) if r.status >= 400 else None)
    pg.goto(BASE + "/ro/upload", wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(2500)
    dismiss_overlays(pg)
    fi = pg.locator('input[type="file"]').first
    if not fi.count():
        J.log(f"upload {label}", "FAIL", "fara input file: " + pg.inner_text("body")[:150])
        return
    fi.set_input_files(os.path.join(MEDIA, fname))
    pg.wait_for_timeout(3000)
    shot(pg, "P1", f"30-upload-{label}-selectat")
    # completeaza titlul daca exista camp
    t = pg.locator('input[type="text"], textarea').first
    if t.count():
        try: t.fill(title)
        except Exception: pass
    clicked = None
    for nm in ["Publică", "Continuă", "Postează", "Încarcă"]:
        btn = pg.get_by_role("button", name=nm)
        if btn.count():
            try:
                btn.first.click(timeout=5000); clicked = nm; break
            except Exception:
                btn.first.evaluate("el=>el.click()"); clicked = nm + "(js)"; break
    pg.wait_for_timeout(2000)
    # daca a aparut pas 2 (detalii), completeaza si publica
    t2 = pg.locator('input[type="text"]').first
    if t2.count():
        try: t2.fill(title)
        except Exception: pass
    for nm in ["Publică", "Postează", "Finalizează"]:
        btn = pg.get_by_role("button", name=nm)
        if btn.count():
            try: btn.first.click(timeout=5000)
            except Exception: btn.first.evaluate("el=>el.click()")
            break
    ok_words = ["Publicat", "procesare", "Gata", "succes", "trimis", "Se procesează"]
    outcome = ""
    for i in range(30):
        pg.wait_for_timeout(5000)
        body = pg.inner_text("body")
        hit = [w for w in ok_words if w in body]
        if hit:
            outcome = str(hit); break
        if "/upload" not in pg.url:
            outcome = "redirect:" + pg.url; break
    shot(pg, "P1", f"31-upload-{label}-final")
    J.log(f"upload {label}", "INFO", f"clicked={clicked} outcome={outcome!r} url={pg.url} fails={fails[:6]}")

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = new_ctx(b)
    pg = ctx.new_page()
    J.log("login", "PASS" if login(pg, "creator@swypik.test") else "FAIL", pg.url)
    run_upload(pg, "clip_portrait_15s.mp4", "portrait15s", "Clip QA portrait aai")
    run_upload(pg, "clip_test.mov", "mov", "Clip QA mov")
    run_upload(pg, "fake_video.mp4", "fake", "Clip QA fake txt")
    out, _ = sql("SELECT v.id, v.title, v.status FROM videos v ORDER BY v.created_at DESC LIMIT 8")
    J.log("videos DB dupa upload", "INFO", out)
    b.close()
J.dump()
