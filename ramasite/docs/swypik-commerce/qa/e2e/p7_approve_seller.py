# -*- coding: utf-8 -*-
"""P7 - aprobare seller din UI admin."""
import sys, os, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, new_ctx, sql, shot, dismiss_overlays, admin_login

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = new_ctx(b, mobile=False)
    pg = ctx.new_page()
    print("admin login:", admin_login(pg))
    pg.goto(BASE + "/admin/sellers", wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(2500)
    dismiss_overlays(pg)
    posts = []
    pg.on("response", lambda r: posts.append((r.request.method, r.status, r.url[:110]))
          if r.request.method == "POST" else None)
    btn = pg.get_by_role("button", name="Aprobă").first
    try:
        btn.click(timeout=5000)
    except Exception:
        btn.evaluate("el=>el.click()")
    pg.wait_for_timeout(6000)
    print("POSTs:", posts)
    print("body:", pg.inner_text("body")[300:700].replace("\n", "|"))
    shot(pg, "P7", "06-dupa-aprobare-seller")
    print("status:", sql("SELECT status FROM sellers WHERE email='seller@swypik.test'")[0])
    b.close()
