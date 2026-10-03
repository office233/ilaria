# -*- coding: utf-8 -*-
"""P2d - retest comentariu dupa fix CSRF middleware."""
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, new_ctx, login, shot, dismiss_overlays, sql

VID = "446ded17-dfab-4629-b1e9-c94f5e844304"
before, _ = sql(f"SELECT count(*) FROM comments WHERE video_id='{VID}'")
print("comentarii inainte:", before)

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = new_ctx(b); pg = ctx.new_page()
    resp = []
    pg.on("response", lambda r: resp.append((r.request.method, r.status, r.url[-60:]))
          if "comment" in r.url else None)
    login(pg, "viewer@swypik.test")
    pg.goto(BASE + "/ro/explore", wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(4000); dismiss_overlays(pg)
    pg.locator('button[aria-label="Discuții"]').first.click()
    pg.wait_for_timeout(2500)
    ta = pg.locator("textarea").first
    ta.click(); ta.type("Comentariu QA ășț retest", delay=15)
    shot(pg, "P2", "30-comentariu-scris")
    btn = pg.get_by_role("button", name="Trimite comentariul").first
    btn.click(timeout=10000)
    pg.wait_for_timeout(4000)
    shot(pg, "P2", "31-comentariu-trimis")
    print("network:", resp)
    after, _ = sql(f"SELECT count(*) FROM comments WHERE video_id='{VID}'")
    print("comentarii dupa:", after)
    print("VERDICT:", "PASS" if int(after) > int(before) else "FAIL")
    print(sql(f"SELECT body FROM comments WHERE video_id='{VID}' ORDER BY created_at DESC LIMIT 2")[0])
    b.close()
