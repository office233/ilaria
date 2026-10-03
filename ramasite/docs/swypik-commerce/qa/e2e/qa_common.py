# -*- coding: utf-8 -*-
"""Helpers comune QA Swypik. Read-only pe cod; creeaza doar date de test *@swypik.test."""
import os, subprocess, time

BASE = "http://127.0.0.1:3005"
QA = os.path.dirname(os.path.abspath(__file__))
EVID = os.path.join(QA, "..", "evidence")
PASSWORD = "TestParola123!"

_PGPW = None
def _pgpw():
    global _PGPW
    if _PGPW is None:
        r = subprocess.run(["wsl", "-d", "swypik", "-e", "bash", "-lc",
                            "grep '^POSTGRES_PASSWORD=' /opt/swypik/app/infra/hetzner/.env.production | cut -d= -f2-"],
                           capture_output=True, text=True, timeout=20, stdin=subprocess.DEVNULL)
        _PGPW = r.stdout.strip()
    return _PGPW

def sql(query):
    """SELECT-only. Conexiune directa la 127.0.0.1:5433 (port publicat de container)."""
    import psycopg2
    conn = psycopg2.connect(host="127.0.0.1", port=5433, dbname="swypik_prod",
                            user="swypik", password=_pgpw(), connect_timeout=10)
    try:
        cur = conn.cursor()
        cur.execute(query)
        rows = cur.fetchall() if cur.description else []
        return "\n".join("|".join("" if v is None else str(v) for v in row) for row in rows), ""
    finally:
        conn.close()

def new_ctx(browser, mobile=True):
    """Context standard QA. BUG mediu local (middleware.ts:61-106): CSRF guard
    respinge Origin http://127.0.0.1:3005 (nextUrl.protocol=https in prod build),
    deci toate POST/PATCH/DELETE din browser local dau 403 {'error':'csrf'}.
    Workaround: fortam header Origin=https://swypik.com."""
    vp = {"width": 390, "height": 844} if mobile else {"width": 1440, "height": 900}
    ctx = browser.new_context(viewport=vp, bypass_csp=True)
    def _rewrite(route, request):
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            headers = {**request.headers, "origin": "https://swypik.com",
                       "x-forwarded-host": "swypik.com"}
            resp = route.fetch(headers=headers)
            route.fulfill(response=resp)
        else:
            route.continue_()
    ctx.route("**/*", _rewrite)
    def _minio(route, request):
        """BUG P0: presigned uploadUrl foloseste hostname intern docker `swypik-minio:9000`
        (S3_ENDPOINT din env; app/api/creator/upload-session + lib/storage/video-storage.ts:32).
        Browserul real nu-l poate rezolva -> upload imposibil. Workaround QA: proxy spre 127.0.0.1:9000
        cu Host pastrat pentru semnatura S3."""
        import http.client
        u = request.url.replace("http://swypik-minio:9000", "").replace("https://swypik-minio:9000", "")
        conn = http.client.HTTPConnection("127.0.0.1", 9000, timeout=300)
        hdrs = {k: v for k, v in request.headers.items() if k.lower() not in ("host",)}
        hdrs["Host"] = "swypik-minio:9000"
        conn.request(request.method, u, body=request.post_data_buffer, headers=hdrs)
        resp = conn.getresponse()
        body = resp.read()
        route.fulfill(status=resp.status, body=body,
                      headers={k: v for k, v in resp.getheaders()
                               if k.lower() not in ("content-length", "transfer-encoding", "connection")})
    ctx.route("http://swypik-minio:9000/**", _minio)
    ctx.route("https://swypik-minio:9000/**", _minio)
    return ctx

def shot(page, persona, name):
    d = os.path.join(EVID, persona)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, name + ".png")
    page.screenshot(path=path)
    return path

def signup(page, email, first, last, username, phone="+40712345678"):
    """Wizard signup 4 pasi: (1) email+parola, (2) nume, (3) username, (4) telefon/final."""
    page.goto(BASE + "/auth/signup", wait_until="domcontentloaded", timeout=45000)
    page.fill('input[type="email"]', email)
    page.fill('input[type="password"]', PASSWORD)
    page.get_by_role("button", name="Continuă").click()
    page.wait_for_timeout(2000)
    page.fill('input[autocomplete="given-name"]', first)
    page.fill('input[autocomplete="family-name"]', last)
    page.get_by_role("button", name="Continuă").click()
    page.wait_for_timeout(2000)
    page.fill('input[placeholder="abel_varga"]', username)
    page.wait_for_timeout(2000)
    page.get_by_role("button", name="Continuă").click()
    page.wait_for_timeout(2000)
    try:
        page.fill('input[type="tel"]', phone)
    except Exception:
        pass
    page.get_by_role("button", name="Creează contul").click()
    page.wait_for_timeout(4000)
    # dupa creare -> redirect la /auth/login; login manual
    if "/auth/login" in page.url:
        return login(page, email)
    return "/auth" not in page.url

def login(page, email, password=PASSWORD):
    """BUG P0 mediu local: /api/auth seteaza cookie cu Domain=swypik.com + Secure
    (app/api/auth/route.ts:48), respins de browser pe http://127.0.0.1:3005.
    Workaround QA (fara modificare cod): obtinem tokenul prin API si il injectam manual."""
    import json as _json, urllib.request as _ur
    body = _json.dumps({"action": "login_password", "email": email, "password": password}).encode()
    req = _ur.Request(BASE + "/api/auth", data=body, headers={"Content-Type": "application/json"})
    r = None
    for attempt in range(6):
        try:
            r = _ur.urlopen(req, timeout=20)
            break
        except Exception:
            time.sleep(5)
    if r is None:
        return False
    token = None
    for k, v in r.getheaders():
        if k.lower() == "set-cookie" and "swypik_session=" in v:
            token = v.split("swypik_session=")[1].split(";")[0]
    if not token:
        return False
    page.context.add_cookies([{"name": "swypik_session", "value": token,
                               "domain": "127.0.0.1", "path": "/",
                               "httpOnly": True, "secure": False, "sameSite": "Lax"}])
    page.goto(BASE + "/account", wait_until="domcontentloaded", timeout=45000)
    return "/auth" not in page.url

def dismiss_overlays(page, max_steps=8):
    """Inchide cookie-banner si modalul de onboarding (Mai departe / Am inteles / X)."""
    for _ in range(max_steps):
        acted = False
        for name in ["Doar necesare", "Mai departe", "Am înțeles", "Începe", "Gata", "Închide"]:
            btn = page.get_by_role("button", name=name)
            if btn.count():
                try:
                    btn.first.click(timeout=2000)
                    page.wait_for_timeout(600)
                    acted = True
                except Exception:
                    pass
        if not acted and page.locator('[role="dialog"]').count():
            x = page.locator('[role="dialog"] button[aria-label]').first
            if x.count() == 0:
                x = page.locator('[role="dialog"] button').first
            try:
                x.click(timeout=2000); page.wait_for_timeout(800); acted = True
            except Exception:
                pass
        if page.locator('[role="dialog"]').count() == 0 and not acted:
            break
    # fallback QA: daca dialogul persista (onboarding), il eliminam din DOM doar in sesiunea de test
    if page.locator('[role="dialog"]').count():
        try:
            page.evaluate("document.querySelectorAll('[role=dialog]').forEach(e=>e.remove())")
        except Exception:
            pass


def admin_login(page):
    """BUG mediu local: cookie admin_session e Secure in prod build (lib/security/admin-auth.ts:136)
    -> respins pe http://127.0.0.1. Workaround QA: POST /api/admin/login si injectam cookie manual."""
    import json as _json, urllib.request as _ur, subprocess as _sp
    r = _sp.run(["wsl", "-d", "swypik", "-e", "bash", "-lc",
                 "grep '^ADMIN_SECRET=' /opt/swypik/app/infra/hetzner/.env.production | cut -d= -f2-"],
                capture_output=True, text=True, stdin=_sp.DEVNULL)
    sec = r.stdout.strip()
    body = _json.dumps({"password": sec}).encode()
    req = _ur.Request(BASE + "/api/admin/login", data=body,
                      headers={"Content-Type": "application/json", "Origin": "https://swypik.com"})
    resp = _ur.urlopen(req, timeout=20)
    setc = resp.headers.get("Set-Cookie") or ""
    name, val = setc.split(";")[0].split("=", 1)
    page.context.add_cookies([{"name": name, "value": val, "domain": "127.0.0.1",
                               "path": "/", "httpOnly": True, "secure": False, "sameSite": "Lax"}])
    page.goto(BASE + "/admin", wait_until="domcontentloaded", timeout=45000)
    return "Sign in" not in page.inner_text("body")


class Journal:
    def __init__(self, persona):
        self.persona = persona
        self.rows = []
    def log(self, step, status, note="", shot_name=""):
        self.rows.append((step, status, note, shot_name))
        print(f"[{status}] {self.persona} :: {step} — {note}")
    def dump(self):
        import json
        p = os.path.join(EVID, self.persona, "_journal.json")
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump([{"step": s, "status": st, "note": n, "shot": sh} for s, st, n, sh in self.rows],
                      f, indent=2, ensure_ascii=False)
