import os, re, sys, json
ROOT = r'E:\Therapium'
EXT = {'.md', '.py', '.js', '.mjs', '.cjs', '.json', '.txt', '.ps1', '.bat', '.cmd', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.sh', '.liquid', '.html', '.csv', '.env'}
SKIP = {'node_modules', '_arhiva-sesiuni', '.git'}
PAT = re.compile(r'([Dd]):((?:\\|\|/)+)([Tt]herapium)')
apply = len(sys.argv) > 1 and sys.argv[1] == 'apply'
hits = {}
for dp, dn, fn in os.walk(ROOT):
    dn[:] = [d for d in dn if d not in SKIP]
    for f in fn:
        if os.path.splitext(f)[1].lower() not in EXT: continue
        p = os.path.join(dp, f)
        if os.path.getsize(p) > 20_000_000: continue
        rp = os.path.relpath(p, ROOT).lower()
        if any(x in rp for x in (os.sep+'before'+os.sep, os.sep+'evidence'+os.sep, 'qa-original', 'agy_log')): continue
        try: s = open(p, encoding='utf-8').read()
        except Exception: continue
        n = len(PAT.findall(s))
        if n:
            hits[os.path.relpath(p, ROOT)] = n
            if apply:
                s2 = PAT.sub(lambda m: 'E:' + m.group(2) + m.group(3), s)
                open(p, 'w', encoding='utf-8', newline='').write(s2)
print('files', len(hits), 'occurrences', sum(hits.values()))
for k, v in sorted(hits.items(), key=lambda x: -x[1])[:40]: print(v, k)
json.dump(hits, open(r'E:\_move_logs\paths_' + ('applied' if apply else 'scan') + '.json', 'w', encoding='utf-8'), indent=0, ensure_ascii=False)
