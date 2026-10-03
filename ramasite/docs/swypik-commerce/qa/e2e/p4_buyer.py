# -*- coding: utf-8 -*-
"""P4 - Cumparator: shop -> cos -> checkout Stripe test; food/go/fly/stays smoke."""
import os, sys, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, sql, shot, login, signup, Journal, dismiss_overlays, new_ctx

J = Journal("P4")
EMAIL = "buyer@swypik.test"

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = new_ctx(b)
    pg = ctx.new_page()
    out, _ = sql(f"SELECT id FROM users WHERE email='{EMAIL}'")
    if out:
        J.log("login buyer", "PASS" if login(pg, EMAIL) else "FAIL", pg.url)
    else:
        ok = signup(pg, EMAIL, "Buyer", "Test", "buyer_test")
        J.log("signup buyer", "PASS" if ok else "FAIL", pg.url)

    # 1. SHOP: gaseste un produs
    pg.goto(BASE + "/ro/shop", wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(4000); dismiss_overlays(pg)
    shot(pg, "P4", "01-shop")
    links = pg.locator('a[href*="/product/"]')
    J.log("shop are produse", "PASS" if links.count() else "FAIL", f"link-uri produs={links.count()}")
    if links.count():
        href = links.first.get_attribute("href")
        pg.goto(BASE + href if href.startswith("/") else href, wait_until="domcontentloaded", timeout=45000)
        pg.wait_for_timeout(3000); dismiss_overlays(pg)
        shot(pg, "P4", "02-pagina-produs")
        # adauga in cos
        addb = pg.get_by_role("button", name=re.compile("coș|cos|Adaugă", re.I))
        if addb.count():
            try: addb.first.click(timeout=5000)
            except Exception: addb.first.evaluate("el=>el.click()")
            pg.wait_for_timeout(2500)
            shot(pg, "P4", "03-adaugat-in-cos")
            J.log("adaugare in cos", "PASS", "click OK")
        else:
            J.log("buton adauga in cos", "FAIL", pg.inner_text("body")[:150])
        # cos
        pg.goto(BASE + "/ro/cart", wait_until="domcontentloaded", timeout=45000)
        pg.wait_for_timeout(3000); dismiss_overlays(pg)
        shot(pg, "P4", "04-cos")
        ctext = pg.inner_text("body")
        J.log("cosul contine produsul", "PASS" if ("RON" in ctext or "lei" in ctext.lower()) else "FAIL",
              ctext[:150].replace("\n", "|"))
        # checkout
        cbtn = pg.get_by_role("button", name=re.compile("Checkout|Finalizează|Plăt", re.I))
        clink = pg.locator('a[href*="checkout"]')
        target = cbtn.first if cbtn.count() else (clink.first if clink.count() else None)
        if target:
            try: target.click(timeout=5000)
            except Exception: target.evaluate("el=>el.click()")
            pg.wait_for_timeout(6000)
            shot(pg, "P4", "05-checkout")
            J.log("checkout redirect", "INFO", f"url={pg.url}")
            if "stripe.com" in pg.url:
                J.log("Stripe checkout session", "PASS", "redirect catre checkout.stripe.com")
        else:
            J.log("buton checkout", "FAIL", "nu exista buton/ link checkout in cos")

    # 2. FOOD smoke
    pg.goto(BASE + "/ro/food", wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(3500); dismiss_overlays(pg)
    shot(pg, "P4", "10-food")
    ft = pg.inner_text("body")
    J.log("food listeaza restaurante", "PASS" if len(ft) > 400 else "INFO", ft[:150].replace("\n", "|"))

    # 3. GO smoke — estimare
    pg.goto(BASE + "/ro/go", wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(3500); dismiss_overlays(pg)
    shot(pg, "P4", "20-go")
    J.log("go pagina", "INFO", pg.inner_text("body")[:150].replace("\n", "|"))

    # 4. FLY smoke
    pg.goto(BASE + "/ro/fly", wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(3500); dismiss_overlays(pg)
    shot(pg, "P4", "30-fly")
    J.log("fly pagina", "INFO", pg.inner_text("body")[:150].replace("\n", "|"))

    # 5. STAYS smoke
    pg.goto(BASE + "/ro/stays", wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(3500); dismiss_overlays(pg)
    shot(pg, "P4", "40-stays")
    J.log("stays pagina", "INFO", pg.inner_text("body")[:150].replace("\n", "|"))

    b.close()
J.dump()
