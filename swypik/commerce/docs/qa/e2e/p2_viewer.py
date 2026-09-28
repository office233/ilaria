# -*- coding: utf-8 -*-
"""P2 - Spectator: like, comentarii, follow, share + consistenta cross-context (P1/P2/incognito)."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, sql, shot, login, signup, Journal, dismiss_overlays, new_ctx

J = Journal("P2")
VIDEO_ID = "446ded17-dfab-4629-b1e9-c94f5e844304"  # clip QA API 15s (ready)

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    # context P2 viewer
    c2 = new_ctx(b); v = c2.new_page()
    out, _ = sql("SELECT id FROM users WHERE email='viewer@swypik.test'")
    if out:
        J.log("login viewer", "PASS" if login(v, "viewer@swypik.test") else "FAIL", v.url)
    else:
        ok = signup(v, "viewer@swypik.test", "Viewer", "Test", "viewer_test")
        J.log("signup viewer", "PASS" if ok else "FAIL", v.url)
    # context P1 creator
    c1 = new_ctx(b); cr = c1.new_page()
    login(cr, "creator@swypik.test")
    # context incognito
    c0 = new_ctx(b); ig = c0.new_page()

    # 1. Explore feed
    v.goto(BASE + "/ro/explore", wait_until="domcontentloaded", timeout=45000)
    v.wait_for_timeout(4000); dismiss_overlays(v)
    shot(v, "P2", "01-explore-feed")
    vids = v.locator("video").count()
    J.log("explore are video-uri", "PASS" if vids else "FAIL", f"video tags={vids}")

    # 2. LIKE pe clipul QA — direct pe pagina clipului
    v.goto(BASE + f"/ro/video/{VIDEO_ID}", wait_until="domcontentloaded", timeout=45000)
    v.wait_for_timeout(3000); dismiss_overlays(v)
    shot(v, "P2", "02-video-page")
    body = v.inner_text("body")[:200]
    J.log("pagina video individual", "INFO", f"url={v.url} body={body!r}")

    # butoane de like — inventar
    btns = [x.get_attribute("aria-label") for x in v.locator("button[aria-label]").all()]
    J.log("butoane cu aria-label pe pagina video", "INFO", str(btns[:20]))

    like_btn = None
    for lbl in btns:
        if lbl and any(w in lbl.lower() for w in ["like", "îmi place", "apreci", "inim", "vot"]):
            like_btn = v.locator(f'button[aria-label="{lbl}"]').first
            break
    if like_btn:
        like_btn.click(); v.wait_for_timeout(2000)
        shot(v, "P2", "03-dupa-like")
        out, _ = sql(f"SELECT count(*) FROM likes WHERE video_id='{VIDEO_ID}'") if True else ("", "")
        J.log("like DB", "INFO", out)
    else:
        J.log("buton like pe pagina video", "FAIL", f"nu am gasit buton like; aria-labels={btns[:15]}")

    # 3. Comentariu
    ta = v.locator('textarea, input[placeholder*="oment"]').first
    if ta.count():
        ta.fill("Comentariu QA cu diacritice ășț și emoji 🎉")
        v.keyboard.press("Enter")
        v.wait_for_timeout(2500)
        shot(v, "P2", "04-comentariu")
        J.log("comentariu postat", "INFO", "vezi screenshot")
    else:
        J.log("camp comentariu", "FAIL", "nu exista camp de comentariu vizibil pe pagina video")

    # 4. Follow creator din profil public
    v.goto(BASE + "/ro/@creator_test", wait_until="domcontentloaded", timeout=45000)
    v.wait_for_timeout(3000); dismiss_overlays(v)
    shot(v, "P2", "05-profil-creator-din-viewer")
    fbtn = v.get_by_role("button", name="Urmărește")
    if fbtn.count():
        fbtn.first.click(); v.wait_for_timeout(2000)
        shot(v, "P2", "06-dupa-follow")
        out, _ = sql("SELECT count(*) FROM follows") if True else ("", "")
        J.log("follow", "INFO", f"follows total={out}")
    else:
        J.log("buton Urmareste pe profil", "FAIL",
              f"body={v.inner_text('body')[:200]!r}")

    # 5. CONSISTENTA: profil creator din 3 contexte
    for pg, name, who in [(cr, "07-profil-creator-el-insusi", "creator"),
                          (v, "08-profil-creator-viewer", "viewer"),
                          (ig, "09-profil-creator-incognito", "incognito")]:
        pg.goto(BASE + "/ro/@creator_test", wait_until="domcontentloaded", timeout=45000)
        pg.wait_for_timeout(3500); dismiss_overlays(pg)
        shot(pg, "P2", name)
        t = pg.inner_text("body")
        import re
        nums = re.findall(r"\d+[.,]?\d*\s*(?:clip|urmăr|follow|videocl)", t.lower())
        J.log(f"profil vazut de {who}", "INFO", f"contoare={nums} len={len(t)} url={pg.url}")

    b.close()
J.dump()
