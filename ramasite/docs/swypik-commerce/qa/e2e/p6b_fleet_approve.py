# -*- coding: utf-8 -*-
"""P6b - aprobare Driver Țest din /admin/fleet (butonul corect din randul lui)."""
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, new_ctx, shot, dismiss_overlays, sql, admin_login

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = new_ctx(b, mobile=False); pg = ctx.new_page()
    admin_login(pg)
    pg.goto(BASE + "/admin/fleet", wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(2500); dismiss_overlays(pg)
    row = pg.locator("tr", has_text="Driver Țest").first
    if not row.count():
        row = pg.locator("div,li", has_text="Driver Țest").last
    print("row found:", row.count(), row.inner_text()[:200].replace("\n", "|") if row.count() else "")
    btn = row.get_by_role("button", name=re.compile("Aprob|Approve|Verific", re.I)).first
    if btn.count():
        try: btn.click(timeout=6000)
        except Exception: btn.evaluate("el=>el.click()")
        pg.wait_for_timeout(4000)
    else:
        # poate e link spre detaliu
        lnk = row.locator("a").first
        if lnk.count():
            lnk.click(); pg.wait_for_timeout(2500)
            shot(pg, "P7", "32-fleet-detaliu")
            btn2 = pg.get_by_role("button", name=re.compile("Aprob|Approve", re.I)).first
            if btn2.count():
                try: btn2.click(timeout=6000)
                except Exception: btn2.evaluate("el=>el.click()")
                pg.wait_for_timeout(4000)
    shot(pg, "P7", "33-fleet-dupa-aprobare-driver")
    print("DB:", sql("SELECT full_name, verification_status FROM couriers WHERE full_name='Driver Țest'")[0])
    b.close()
