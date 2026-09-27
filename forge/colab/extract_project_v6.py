"""Extract v6 pilot generations without interpreting substring metrics as quality."""
import json
from pathlib import Path
import re

root=Path(__file__).resolve().parents[2]/'results/ilaria-project-v6'
for variant in ['before','after']:
    source=root/f'{variant}-transcripts.txt'
    if not source.exists():
        continue
    tasks=[json.loads(s) for s in (root/('all-tasks.jsonl' if variant=='after' else 'tasks.jsonl')).read_text(encoding='utf-8').splitlines()]
    blocks=re.split(r'\[transcript\] ',source.read_text(encoding='utf-8'))[1:]
    assert len(blocks)==len(tasks), (variant,len(blocks))
    rows=[]
    for task,block in zip(tasks,blocks):
        prompt,transcript=block.split('\n',1)
        assert json.loads(prompt)==task['prompt']
        body=transcript.split('\n---',1)[0].split('<|eot_id|>User: ',1)[1].split('<|eot_id|>Assistant: ',1)[1].strip()
        rows.append({**task,'generation':body})
    (root/f'{variant}-answers.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
    print(variant,len(rows))
