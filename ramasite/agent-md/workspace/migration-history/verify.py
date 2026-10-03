import os, hashlib, sys, json
from concurrent.futures import ThreadPoolExecutor
A, B = r'D:\Therapium', r'E:\Therapium'
def walk(root):
    out = {}
    for dp, dn, fn in os.walk(root):
        for f in fn:
            p = os.path.join(dp, f)
            out[os.path.relpath(p, root)] = os.path.getsize(p)
    return out
def md5(p):
    h = hashlib.md5()
    with open(p, 'rb') as fh:
        for ch in iter(lambda: fh.read(1 << 20), b''):
            h.update(ch)
    return h.hexdigest()
a, b = walk(A), walk(B)
only_a = sorted(set(a) - set(b)); only_b = sorted(set(b) - set(a))
size_diff = sorted(k for k in set(a) & set(b) if a[k] != b[k])
common = sorted(set(a) & set(b))
def cmp(k):
    try:
        return k, md5(os.path.join(A, k)) == md5(os.path.join(B, k))
    except Exception as e:
        return k, 'ERR ' + str(e)
with ThreadPoolExecutor(16) as ex:
    res = list(ex.map(cmp, common))
hash_bad = [k for k, ok in res if ok is not True]
rep = {'files_D': len(a), 'files_E': len(b), 'bytes_D': sum(a.values()), 'bytes_E': sum(b.values()),
       'only_on_D': only_a, 'only_on_E': only_b[:50], 'size_mismatch': size_diff, 'md5_mismatch_or_error': hash_bad,
       'md5_checked': len(common)}
json.dump(rep, open(r'E:\_move_logs\verify.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(json.dumps({k: (v if not isinstance(v, list) else len(v)) for k, v in rep.items()}, indent=1))
print('only_on_D sample:', only_a[:20]); print('md5 bad sample:', hash_bad[:20])
