"""Package the exact project pilot and verification cells for reproducibility."""
import ast
import json
from pathlib import Path

p=Path(__file__).resolve().parent
notebook=json.loads((p/'Ilaria_Aligned_V4.ipynb').read_text(encoding='utf-8'))
notebook['cells']=notebook['cells'][:6]
notebook['cells'][0]={'cell_type':'markdown','metadata':{},'source':'# Ilaria project v6 — English\n200-step experimental SwypikOS/Swyp Lang continuation. Requires the verified v5 adapter in Drive. Run cells individually. No Swyp chat tool is registered by this notebook. Compiler-tested scalar code examples and evidence-grounded answers are trained; no repository dump is included. Output directories are protected. Python evaluation is separate from final Go verification.'}
for name in ['project-v6-run.py','project-v6-verify.py']:
    source=(p/name).read_text(encoding='utf-8')
    ast.parse(source)
    notebook['cells'].append({'cell_type':'code','metadata':{},'execution_count':None,'outputs':[],'source':source})
(p/'Ilaria_Project_V6.ipynb').write_text(json.dumps(notebook,indent=2),encoding='utf-8')
print('Ilaria_Project_V6.ipynb saved')
