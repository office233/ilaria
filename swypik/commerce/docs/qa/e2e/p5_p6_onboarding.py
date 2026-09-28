# -*- coding: utf-8 -*-
"""P5 - aplicare restaurant /ro/food/aplica + aprobare admin /admin/aplicatii.
P6 - aplicare curier /ro/join/fleet + verificare /admin/fleet."""
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, new_ctx, login, signup, shot, dismiss_overlays, sql, Journal, admin_login

J = Journal("P56")

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)

    # ===== P5: restaurant =====
    c5 = new_ctx(b); r5 = c5.new_page()
    out, _ = sql("SELECT id FROM users WHERE email='resto@swypik.test'")
    if out:
        login(r5, "resto@swypik.test")
    else:
        signup(r5, "resto@swypik.test", "Resto", "Test", "resto_test")
    r5.goto(BASE + "/ro/food/aplica", wait_until="domcontentloaded", timeout=45000)
    r5.wait_for_timeout(2500); dismiss_overlays(r5)
    shot(r5, "P5", "10-food-aplica")
    for i in r5.locator("form input, form textarea, form select").all():
        nm = (i.get_attribute("name") or "") + "|" + (i.get_attribute("placeholder") or "")
        print("field:", i.evaluate("e=>e.tagName"), nm)
    # completare generica
    for i in r5.locator("form input").all():
        t = i.get_attribute("type") or "text"
        ph = ((i.get_attribute("name") or "") + " " + (i.get_attribute("placeholder") or "")).lower()
        try:
            if t == "email": i.fill("resto@swypik.test")
            elif t == "tel" or "phone" in ph or "telefon" in ph: i.fill("0744555666")
            elif "oras" in ph or "city" in ph: i.fill("București")
            elif "adres" in ph: i.fill("Str. Țestelor 10, București")
            elif t == "text": i.fill("Restaurantul Țest QA")
        except Exception: pass
    for i in r5.locator("form textarea").all():
        try: i.fill("Restaurant de test QA cu specific românesc")
        except Exception: pass
    sel = r5.locator("form select").first
    if sel.count():
        try: sel.select_option(index=1)
        except Exception: pass
    shot(r5, "P5", "11-food-aplica-completat")
    sub = r5.locator('form button[type="submit"]').first
    if not sub.count():
        sub = r5.get_by_role("button", name=re.compile("Trimite|Aplică", re.I)).first
    try: sub.click(timeout=6000)
    except Exception: sub.evaluate("el=>el.click()")
    r5.wait_for_timeout(4000)
    shot(r5, "P5", "12-food-aplica-dupa-submit")
    out, _ = sql("SELECT id, name, status FROM local_merchants ORDER BY created_at DESC LIMIT 3")
    J.log("aplicare restaurant in DB", "PASS" if "Țest" in out or "QA" in out else "FAIL", out or "gol")

    # aprobare admin
    a = new_ctx(b, mobile=False); ap = a.new_page()
    admin_login(ap)
    ap.goto(BASE + "/admin/aplicatii", wait_until="domcontentloaded", timeout=45000)
    ap.wait_for_timeout(2500); dismiss_overlays(ap)
    shot(ap, "P7", "20-admin-aplicatii")
    apr = ap.get_by_role("button", name=re.compile("Aprob", re.I))
    if apr.count():
        try: apr.first.click(timeout=6000)
        except Exception: apr.first.evaluate("el=>el.click()")
        ap.wait_for_timeout(4000)
        shot(ap, "P7", "21-admin-aplicatii-dupa-aprobare")
    out, _ = sql("SELECT name, status FROM local_merchants ORDER BY created_at DESC LIMIT 3")
    J.log("aprobare restaurant din admin UI", "PASS" if "active" in out else "FAIL", out)

    # ===== P6: curier/sofer =====
    c6 = new_ctx(b); r6 = c6.new_page()
    out, _ = sql("SELECT id FROM users WHERE email='driver@swypik.test'")
    if out:
        login(r6, "driver@swypik.test")
    else:
        signup(r6, "driver@swypik.test", "Driver", "Test", "driver_test")
    r6.goto(BASE + "/ro/join/fleet", wait_until="domcontentloaded", timeout=45000)
    r6.wait_for_timeout(2500); dismiss_overlays(r6)
    shot(r6, "P6", "10-join-fleet")
    for i in r6.locator("form input, form select").all():
        print("field:", (i.get_attribute("name") or "") + "|" + (i.get_attribute("placeholder") or ""))
    for i in r6.locator("form input").all():
        t = i.get_attribute("type") or "text"
        ph = ((i.get_attribute("name") or "") + " " + (i.get_attribute("placeholder") or "")).lower()
        try:
            if t == "email": i.fill("driver@swypik.test")
            elif t == "tel" or "phone" in ph: i.fill("0755666777")
            elif "oras" in ph or "city" in ph: i.fill("București")
            elif t == "text": i.fill("Driver Țest")
        except Exception: pass
    sel = r6.locator("form select")
    for s in sel.all():
        try: s.select_option(index=1)
        except Exception: pass
    shot(r6, "P6", "11-join-fleet-completat")
    sub = r6.locator('form button[type="submit"]').first
    if not sub.count():
        sub = r6.get_by_role("button", name=re.compile("Trimite|Aplică", re.I)).first
    try: sub.click(timeout=6000)
    except Exception: sub.evaluate("el=>el.click()")
    r6.wait_for_timeout(4000)
    shot(r6, "P6", "12-join-fleet-dupa-submit")
    out, _ = sql("SELECT id, full_name, verification_status FROM couriers ORDER BY created_at DESC LIMIT 3")
    J.log("aplicare curier in DB", "PASS" if "Țest" in out else "FAIL", out)

    # admin/fleet aprobare
    ap.goto(BASE + "/admin/fleet", wait_until="domcontentloaded", timeout=45000)
    ap.wait_for_timeout(2500); dismiss_overlays(ap)
    shot(ap, "P7", "30-admin-fleet")
    apr = ap.get_by_role("button", name=re.compile("Aprob|Approve", re.I))
    if apr.count():
        try: apr.first.click(timeout=6000)
        except Exception: apr.first.evaluate("el=>el.click()")
        ap.wait_for_timeout(4000)
        shot(ap, "P7", "31-admin-fleet-dupa-aprobare")
    out, _ = sql("SELECT full_name, verification_status FROM couriers ORDER BY created_at DESC LIMIT 3")
    J.log("aprobare curier din admin UI", "PASS" if "approved" in out else "FAIL", out)

    # PWA curier
    r6.goto(BASE + "/courier", wait_until="domcontentloaded", timeout=45000)
    r6.wait_for_timeout(3000); dismiss_overlays(r6)
    shot(r6, "P6", "13-courier-pwa")
    J.log("PWA /courier", "INFO", r6.inner_text("body")[:150].replace("\n", "|"))

    b.close()
J.dump()