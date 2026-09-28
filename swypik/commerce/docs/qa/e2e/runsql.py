import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qa_common import sql
q = " ".join(sys.argv[1:])
out, err = sql(q)
print(out)
if err:
    print("ERR:", err)
