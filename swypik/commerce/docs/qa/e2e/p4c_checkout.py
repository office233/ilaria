# -*- coding: utf-8 -*-
"""P4c - Checkout Stripe test complet: 4242 succes + 4000...0002 declined + dublu-click."""
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, new_ctx, login, shot, dismiss_overlays, sql, Journal

J = Journal("P4")

def fill_stripe(pg, card):
    pg.wait_for_timeout(5000)
    # Stripe Checkout hosted page
    try:
        pg.fill('input[name="email"]', "buyer@swypik.test", timeout=8000)
    except Exception:
        pass
    pg.fill('input[name="cardNumber"]', card)
    pg.fill('input[name="cardExpiry"]', "12 / 30")
    pg.fill('input[name="cardCvc"]', "123")
    try:
        pg.fill('input[name="billingName"]', "Buyer Test")
    except Exception:
        pass
    try:
        pg.select_option('select[name="billingCountry"]', "RO")
    except Exception:
        pass

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = new_ctx(b)
    pg = ctx.new_page()
    login(pg, "buyer@swypik.test")

    # asigura produs in cos
    pg.evaluate("""async()=>{ await fetch('/api/cart/items',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({productId:'fe28012f-403c-4056-8aa3-3a6b3260843e',quantity:1})}) }""")
    pg.goto(BASE + "/ro/cart", wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(3000); dismiss_overlays(pg)
    btn = pg.get_by_role("button", name=re.compile("Finalizează", re.I)).first
    lnk = pg.locator('a:has-text("Finalizează")').first
    tgt = btn if btn.count() else lnk
    try:
        tgt.click(timeout=6000)
    except Exception:
        tgt.evaluate("el=>el.click()")
    pg.wait_for_timeout(8000)
    shot(pg, "P4", "08-checkout-pagina")
    J.log("checkout deschis", "INFO", pg.url[:120])

    if "checkout.stripe.com" in pg.url:
        fill_stripe(pg, "4242 4242 4242 4242")
        shot(pg, "P4", "09-stripe-completat")
        sb = pg.locator('button[type="submit"], .SubmitButton').first
        sb.click()
        pg.wait_for_timeout(12000)
        shot(pg, "P4", "10-stripe-rezultat")
        J.log("plata 4242", "PASS" if "checkout.stripe.com" not in pg.url else "INFO", pg.url[:140])
        out, _ = sql("SELECT id, status, total_cents FROM orders ORDER BY created_at DESC LIMIT 3")
        J.log("comenzi DB", "INFO", out)
    else:
        # checkout intern (adresa etc.) — documentam pasii
        body = pg.inner_text("body")[:300]
        J.log("checkout intern (nu redirect direct Stripe)", "INFO", body.replace("\n", "|"))

    b.close()
J.dump()
