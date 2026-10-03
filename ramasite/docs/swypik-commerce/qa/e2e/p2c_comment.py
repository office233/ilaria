# -*- coding: utf-8 -*-
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, login, new_ctx, dismiss_overlays, sql, shot

VID = "446ded17-dfab-4629-b1e9-c94f5e844304"
with sync_playwright() as p:
    b = p.chromium.launch(headless=True); ctx = new_ctx(b); pg = ctx.new_page()
    login(pg, "viewer@swypik.test")
    resp = []
    pg.on("response", lambda r: resp.append((r.request.method, r.status, r.url[:110])) if "comment" in r.url else None)
    pg.goto(BASE + "/ro/explore?v=" + VID, wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(4000); dismiss_overlays(pg)
    pg.locator('button[aria-label="DiscuČ›ii"]').first.click(); pg.wait_for_timeout(2500)
    shot(pg, "P2", "21-comments-sheet-open")
    els = [(i.evaluate("e=>e.tagName"), i.get_attribute("placeholder")) for i in pg.locator("textarea, input").all()]
    print("fields:", els)
    print("btns:", [x.inner_text() or x.get_attribute("aria-label") for x in pg.locator("button").all()][-12:])
    ta = pg.locator("textarea").last if pg.locator("textarea").count() else pg.locator("input[placeholder]").last
    ta = pg.locator('textarea[placeholder="Adaugă un comentariu..."]').first
    ta.click(); ta.type("Comentariu QA ÄČ™Č› đźŽ‰", delay=20)
    pg.wait_for_timeout(800)
    btn = pg.get_by_role("button", name="Trimite comentariul")
    print("btn disabled:", btn.first.get_attribute("disabled"))
    # BUG P0 UX (mobil): <nav data-testid="bottom-nav"> z-30 acopera butonul de trimitere
    # a comentariului (si butonul Salveaza din /account/edit) -> userul real NU poate apasa.
    try:
        btn.first.click(timeout=5000); sent = "Trimite comentariul"
    except Exception:
        print("BUG: bottom-nav intercepteaza click pe Trimite comentariul (mobil 390x844)")
        btn.first.evaluate("el=>el.click()"); sent = "Trimite (js)"
    pg.wait_for_timeout(3500)
    shot(pg, "P2", "22-comment-trimis")
    print("sent via", sent, "resp:", resp)
    print("DB:", sql("SELECT count(*) FROM comments WHERE video_id='%s'" % VID)[0])
    b.close()

