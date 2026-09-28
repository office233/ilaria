# -*- coding: utf-8 -*-
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, new_ctx, dismiss_overlays, login, shot, sql

with sync_playwright() as p:
    b = p.chromium.launch(headless=True); ctx = new_ctx(b); pg = ctx.new_page()
    login(pg, "buyer@swypik.test")
    posts = []
    pg.on("response", lambda r: posts.append((r.request.method, r.status, r.url[:110]))
          if ("cart" in r.url or "basket" in r.url) else None)
    pg.goto(BASE + "/ro/shop", wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(4000); dismiss_overlays(pg)
    href = pg.locator('a[href*="product"]').first.get_attribute("href")
    print("produs:", href)
    pg.goto(BASE + href, wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(3000); dismiss_overlays(pg)
    print("butoane:", [x.inner_text()[:40].replace("\n", " ") for x in pg.locator("button").all()])
    ab = pg.get_by_role("button", name=re.compile("coș|Adaugă", re.I)).first
    ab.evaluate("el=>el.click()")
    pg.wait_for_timeout(4000)
    print("posts cart:", posts)
    print("DB carts:", sql("SELECT c.id, c.user_id, count(ci.id) FROM carts c LEFT JOIN cart_items ci ON ci.cart_id=c.id GROUP BY c.id, c.user_id ORDER BY max(c.updated_at) DESC LIMIT 3")[0])
    shot(pg, "P4", "06-dupa-add-cart-debug")
    b.close()
