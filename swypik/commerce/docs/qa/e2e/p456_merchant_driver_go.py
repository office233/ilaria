# -*- coding: utf-8 -*-
"""P5 restaurant + P6 sofer + P4 Go/Food — cat permite mediul.
Onboarding merchant/driver din UI; aprobare din admin UI; blocajele se raporteaza, nu se ocolesc prin SQL."""
import sys, os, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
from qa_common import BASE, new_ctx, login, signup, shot, dismiss_overlays, sql, Journal, admin_login

J = Journal("P56")

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)

    # P5: exista pagina de onboarding merchant?
    ctx = new_ctx(b); pg = ctx.new_page()
    for path, name in [("/ro/become-a-partner", "become-a-partner"),
                       ("/ro/merchant", "merchant"),
                       ("/ro/food/merchant", "food-merchant"),
                       ("/merchant/login", "merchant-login")]:
        resp = pg.goto(BASE + path, wait_until="domcontentloaded", timeout=45000)
        pg.wait_for_timeout(2000); dismiss_overlays(pg)
        shot(pg, "P5", f"01-{name}")
        J.log(f"P5 pagina {path}", "INFO", f"status={resp.status} url={pg.url} body={pg.inner_text('body')[:100].replace(chr(10),'|')}")

    # P6: onboarding sofer
    for path, name in [("/ro/become-a-driver", "become-a-driver"),
                       ("/ro/driver", "driver"),
                       ("/driver/login", "driver-login"),
                       ("/ro/go/driver", "go-driver")]:
        resp = pg.goto(BASE + path, wait_until="domcontentloaded", timeout=45000)
        pg.wait_for_timeout(2000); dismiss_overlays(pg)
        shot(pg, "P6", f"01-{name}")
        J.log(f"P6 pagina {path}", "INFO", f"status={resp.status} url={pg.url} body={pg.inner_text('body')[:100].replace(chr(10),'|')}")

    # P4 GO: estimare cursa ca buyer
    login(pg, "buyer@swypik.test")
    pg.goto(BASE + "/ro/go", wait_until="domcontentloaded", timeout=45000)
    pg.wait_for_timeout(3500); dismiss_overlays(pg)
    shot(pg, "P4", "21-go-logat")
    inputs = [(i.get_attribute("placeholder") or "") for i in pg.locator("input").all()]
    J.log("go inputs", "INFO", str(inputs))
    out, _ = sql("SELECT count(*) FROM pricing_zones")
    J.log("pricing_zones in DB", "INFO", out)
    out, _ = sql("SELECT count(*) FROM couriers")
    J.log("couriers in DB", "INFO", out)
    out, _ = sql("SELECT count(*) FROM local_merchants")
    J.log("local_merchants in DB", "INFO", out)

    b.close()
J.dump()
