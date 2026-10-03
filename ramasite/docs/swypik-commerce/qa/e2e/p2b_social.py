# -*- coding: utf-8 -*-
"""P2b - Like/comentarii/follow in explore + consistenta /u/creator_test in 3 contexte."""
import os, sys, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, sql, shot, login, Journal, dismiss_overlays, new_ctx

J = Journal("P2")
VIDEO_ID = "446ded17-dfab-4629-b1e9-c94f5e844304"

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    c2 = new_ctx(b); v = c2.new_page()
    login(v, "viewer@swypik.test")
    c1 = new_ctx(b); cr = c1.new_page()
    login(cr, "creator@swypik.test")
    c0 = new_ctx(b); ig = c0.new_page()

    # deschide clipul QA in player
    v.goto(BASE + f"/ro/explore?v={VIDEO_ID}", wait_until="domcontentloaded", timeout=45000)
    v.wait_for_timeout(4000); dismiss_overlays(v)
    shot(v, "P2", "10-explore-clip-qa")

    def like_state():
        out, _ = sql(f"SELECT count(*) FROM likes WHERE video_id='{VIDEO_ID}'")
        return out

    before = like_state()
    lb = v.locator('button[aria-label="Apreciază"]').first
    if lb.count():
        lb.click(); v.wait_for_timeout(2500)
        shot(v, "P2", "11-dupa-like")
        after = like_state()
        J.log("like scrie in DB", "PASS" if after != before else "FAIL", f"likes {before} -> {after}")
        # refresh persista?
        v.reload(wait_until="domcontentloaded"); v.wait_for_timeout(3500); dismiss_overlays(v)
        shot(v, "P2", "12-like-dupa-refresh")
        # unlike
        v.locator('button[aria-label="Apreciază"]').first.click(); v.wait_for_timeout(2500)
        after2 = like_state()
        J.log("unlike", "PASS" if after2 == before else "FAIL", f"likes {after} -> {after2}")
        # rapid x5 (race)
        for i in range(5):
            v.locator('button[aria-label="Apreciază"]').first.click()
            v.wait_for_timeout(250)
        v.wait_for_timeout(3000)
        final = like_state()
        J.log("like rapid x5 race", "PASS" if final in ("0", "1") else "FAIL", f"likes final={final}")
        shot(v, "P2", "13-like-race-final")
    else:
        J.log("buton Apreciaza", "FAIL", "nu exista in player")

    # comentarii
    db_cm_before, _ = sql(f"SELECT count(*) FROM comments WHERE video_id='{VIDEO_ID}'")
    d = v.locator('button[aria-label="Discuții"]').first
    if d.count():
        d.click(); v.wait_for_timeout(2500)
        shot(v, "P2", "14-comments-sheet")
        ta = v.locator("textarea, input[placeholder]").last
        ta.fill("Comentariu QA ășț 🎉")
        v.keyboard.press("Enter")
        v.wait_for_timeout(3000)
        shot(v, "P2", "15-comment-postat")
        db_cm, _ = sql(f"SELECT count(*) FROM comments WHERE video_id='{VIDEO_ID}'")
        J.log("comentariu in DB", "PASS" if db_cm != db_cm_before else "FAIL", f"{db_cm_before} -> {db_cm}")
    else:
        J.log("buton Discutii", "FAIL", "lipseste")

    # follow pe /u/creator_test
    fw_before, _ = sql("SELECT count(*) FROM follows")
    v.goto(BASE + "/ro/u/creator_test", wait_until="domcontentloaded", timeout=45000)
    v.wait_for_timeout(3000); dismiss_overlays(v)
    shot(v, "P2", "16-profil-u-creator")
    fbtn = v.get_by_role("button", name=re.compile("Urm|Follow"))
    if fbtn.count():
        fbtn.first.click(); v.wait_for_timeout(2500)
        fw_after, _ = sql("SELECT count(*) FROM follows")
        J.log("follow in DB", "PASS" if fw_after != fw_before else "FAIL", f"{fw_before} -> {fw_after}")
        shot(v, "P2", "17-dupa-follow")
    else:
        J.log("buton follow pe /u/creator_test", "FAIL", v.inner_text("body")[:150])

    # consistenta profil in 3 contexte
    for pg, name, who in [(cr, "18-profil-creator-self", "creator"),
                          (v, "19-profil-creator-viewer", "viewer"),
                          (ig, "20-profil-creator-incognito", "incognito")]:
        pg.goto(BASE + "/ro/u/creator_test", wait_until="domcontentloaded", timeout=45000)
        pg.wait_for_timeout(3500); dismiss_overlays(pg)
        shot(pg, "P2", name)
        t = pg.inner_text("body")
        nums = re.findall(r"(\d+)\s*(clipuri|urmăritori|urmărește|videoclipuri|Followers|Following)", t, re.I)
        vidcount = pg.locator("a[href*='explore?v='], video, [data-video-id]").count()
        J.log(f"profil /u/creator_test vazut de {who}", "INFO",
              f"contoare={nums} elems_video={vidcount} len={len(t)}")

    b.close()
J.dump()
