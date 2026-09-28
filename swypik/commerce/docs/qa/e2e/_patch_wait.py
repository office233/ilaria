import io
for p in ["docs/qa/e2e/p1_creator_settings_upload.py", "docs/qa/e2e/qa_common.py"]:
    s = io.open(p, encoding="utf-8").read()
    s = s.replace('wait_until="networkidle", timeout=30000', 'wait_until="domcontentloaded", timeout=45000')
    s = s.replace('wait_until="networkidle"', 'wait_until="domcontentloaded", timeout=45000')
    io.open(p, "w", encoding="utf-8").write(s)
print("ok")
