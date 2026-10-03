# -*- coding: utf-8 -*-
"""P7b - dashboard admin (cifre) + moderare: ascunde clipul QA -> verifica public incognito."""
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, new_ctx, shot, dismiss_overlays, sql, admin_login, Journal

J = Journal("P7")
VID = "446ded17-dfab-4629-b1e9-c94f5e844304"

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = new_ctx(b, mobile=False); pg = ctx.new_page()
    pg.on("dialog", lambda d: d.accept())
    admin_login(pg)

    # dashboard cifre
    pg.goto(BASE + "/admin", wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(3000); dismiss_overlays(pg)
    shot(pg, "P7", "40-dashboard")
    body = pg.inner_text("body")
    db_users, _ = sql("SELECT count(*) FROM users")
    db_vids, _ = sql("SELECT count(*) FROM videos")
    db_orders, _ = sql("SELECT count(*) FROM commerce_orders")
    J.log("dashboard vs DB", "INFO",
          f"DB: users={db_users} videos={db_vids} commerce_orders={db_orders}; dashboard_text={body[:400].replace(chr(10),'|')}")

    # moderare: ascunde clipul QA
    pg.goto(BASE + "/admin/moderation", wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(2500); dismiss_overlays(pg)
    shot(pg, "P7", "41-moderation")
    J.log("pagina moderare", "INFO", pg.inner_text("body")[:200].replace("\n", "|"))
    row = pg.locator("tr,div[class*=card]", has_text="Clip QA API").first
    if row.count():
        hb = row.get_by_role("button", name=re.compile("Ascunde|Hide", re.I)).first
        if hb.count():
            hb.click(); pg.wait_for_timeout(4000)
            shot(pg, "P7", "42-dupa-ascundere")
            out, _ = sql(f"SELECT is_hidden, visibility FROM videos WHERE id='{VID}'")
            J.log("clip ascuns in DB", "PASS" if "True" in out or "hidden" in out else "FAIL", out)
            # verificare publica incognito
            c0 = new_ctx(b); ig = c0.new_page()
            ig.goto(BASE + "/ro/u/creator_test", wait_until="domcontentloaded", timeout=45000)
            ig.wait_for_timeout(3000); dismiss_overlays(ig)
            shot(ig, "P7", "43-profil-public-dupa-hide")
            J.log("clip dispare public", "INFO", ig.inner_text("body")[:150].replace("\n", "|"))
        else:
            J.log("buton Ascunde in moderare", "FAIL", row.inner_text()[:150].replace("\n", "|"))
    else:
        J.log("clip QA in lista de moderare", "FAIL", "nu apare in /admin/moderation")

    b.close()
J.dump()
