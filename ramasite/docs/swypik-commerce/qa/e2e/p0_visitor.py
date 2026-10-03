# -*- coding: utf-8 -*-
"""P0 - Vizitator nelogat. Read-only test. Re-rulabil."""
import json, os, sys, time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3005"
EV = os.path.join(os.path.dirname(__file__), "..", "evidence", "P0")
os.makedirs(EV, exist_ok=True)
results = []

def log(step, status, note=""):
    results.append({"step": step, "status": status, "note": note})
    print(f"[{status}] {step} — {note}")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    console_errors = []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    failed_requests = []
    page.on("response", lambda r: failed_requests.append(f"{r.status} {r.url}") if r.status >= 400 else None)

    # 1. Homepage
    t0 = time.time()
    page.goto(BASE + "/", wait_until="networkidle", timeout=30000)
    dt = time.time() - t0
    page.screenshot(path=f"{EV}/01-homepage.png")
    log("homepage load", "PASS" if dt < 3 else "FAIL", f"{dt:.2f}s, console_errors={len(console_errors)}")

    # 2. Limbile
    for loc in ["ro", "en", "es", "fr", "de", "pt", "it"]:
        page.goto(f"{BASE}/{loc}", wait_until="networkidle", timeout=30000)
        html = page.content()
        raw_keys = [k for k in ["common.", "nav.", "home.", "explore."] if f">{k}" in html]
        page.screenshot(path=f"{EV}/02-lang-{loc}.png")
        log(f"lang {loc}", "FAIL" if raw_keys else "PASS", f"raw_keys={raw_keys}")

    # 3. Navigare nelogat
    for path, name in [("/explore", "explore"), ("/shop", "shop"), ("/food", "food"),
                       ("/stays", "stays"), ("/fly", "fly"), ("/go", "go")]:
        resp = page.goto(BASE + path, wait_until="networkidle", timeout=30000)
        page.screenshot(path=f"{EV}/03-{name}.png")
        body_len = len(page.inner_text("body").strip())
        log(f"nav {name}", "PASS" if resp.status == 200 and body_len > 50 else "FAIL",
            f"status={resp.status} url_final={page.url} body_len={body_len}")

    # 4. Legale + 404 + entitate inexistenta
    for path, name in [("/terms", "terms"), ("/privacy", "privacy"),
                       ("/pagina-inventata-xyz", "404"), ("/product/999999", "product-999999")]:
        resp = page.goto(BASE + path, wait_until="networkidle", timeout=30000)
        page.screenshot(path=f"{EV}/04-{name}.png")
        txt = page.inner_text("body")[:200]
        crashed = "Application error" in txt or "Internal Server Error" in txt
        log(f"page {name}", "FAIL" if crashed else "PASS", f"status={resp.status} txt={txt[:80]!r}")

    with open(f"{EV}/console_errors.json", "w", encoding="utf-8") as f:
        json.dump({"console": console_errors, "http4xx5xx": failed_requests}, f, indent=2, ensure_ascii=False)
    browser.close()

print(json.dumps(results, indent=2, ensure_ascii=False))
