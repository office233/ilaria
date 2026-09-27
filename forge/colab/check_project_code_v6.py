"""Compile/check model-produced Swyp and test only its bounded interpreter."""
import json
import re
from pathlib import Path
import subprocess
import tempfile

root=Path(__file__).resolve().parents[2]/'results/ilaria-project-v6'
swyp=Path('D:/swyp lang')
gold={'swyp-affine':lambda x:31*x-8,'swyp-square':lambda x:x*x,
      'swyp-negative':lambda x:-x,'swyp-constant':lambda x:42}
checks=[]
with tempfile.TemporaryDirectory(prefix='v6-eval-') as directory:
    directory=Path(directory)
    exe=directory/'checker.exe'
    subprocess.run(['go','build','-o',str(exe),'./cmd/swyp'],cwd=swyp,check=True)
    for variant in ['before','python-after','after']:
        file=root/f'{variant}-answers.json'
        if not file.exists(): continue
        for row in json.loads(file.read_text(encoding='utf-8')):
            if row['id'] not in gold: continue
            source=directory/'candidate.swyp'
            source.write_text(row['generation'],encoding='utf-8')
            result=subprocess.run([str(exe),'check',str(source)],capture_output=True,text=True,timeout=10)
            record={'variant':variant,'id':row['id'],'compile_pass':result.returncode==0,'diagnostic':result.stderr.strip(),'runs':[]}
            if result.returncode==0:
                for x in [-7,-0.5,0,1,3.25,19]:
                    try:
                        run=subprocess.run([str(exe),'run','-steps','10000',str(source),str(x)],capture_output=True,text=True,timeout=5)
                        actual=float(run.stdout.strip())
                        passed=run.returncode==0 and actual==gold[row['id']](x)
                        record['runs'].append({'x':x,'actual':actual,'expected':gold[row['id']](x),'pass':passed})
                    except (ValueError,subprocess.TimeoutExpired) as error:
                        record['runs'].append({'x':x,'pass':False,'error':type(error).__name__})
            record['behavior_pass']=record['compile_pass'] and len(record['runs'])==6 and all(r['pass'] for r in record['runs'])
            record['requested_entrypoint_pass']=bool(re.search(r'fn\s+predict\s*\(',row['generation']) and re.search(r'print\s*\(\s*predict\s*\(\s*arg\s*\(\s*0\s*\)',row['generation']))
            record['pass']=record['behavior_pass'] and record['requested_entrypoint_pass']
            checks.append(record)
(root/'code-checks.json').write_text(json.dumps(checks,indent=2),encoding='utf-8')
for variant in sorted({r['variant'] for r in checks}):
    rows=[r for r in checks if r['variant']==variant]
    print(variant,sum(r['pass'] for r in rows),'/',len(rows))
