"""Build a small English project pilot; validate generated Swyp using real source."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from forge.tool_data import load_trajectories, validate_splits

ROOT = Path(__file__).resolve().parents[2]
SWYP = Path('D:/swyp lang')
OUT = ROOT / 'forge/colab/project-examples-v6'
EVAL = ROOT / 'results/ilaria-project-v6'
OUT.mkdir(exist_ok=False)
EVAL.mkdir(exist_ok=False)
splits = {s: load_trajectories(ROOT / f'forge/colab/drafting-examples-v5/{s}.jsonl') for s in ('train', 'validation')}
system = splits['train'][0]['messages'][0]['content']
sources = [SWYP/'docs/SWYP_LANG.md', SWYP/'cmd/swyp/worker.go', SWYP/'bridge/ilaria/tool.go', Path('D:/swypik-os/README.md'), ROOT/'cmd/ilaria-serve/main.go']
manifest = {'sources': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}, 'compiler_checks': []}

def add(split, ident, prompt, answer, kind):
    splits[split].append({'language':'en','task_id':ident,'source':kind,'messages':[{'role':'system','content':system},{'role':'user','content':prompt},{'role':'assistant','content':answer}]})

facts = [
 ('SwypikOS runs over Windows as a desktop shell. It is not independently bootable.', 'Is SwypikOS a standalone bootable operating system?', 'No. According to the supplied project note, SwypikOS is a desktop shell running over Windows.'),
 ('Swyp synthesis searches bounded arithmetic expressions from numeric input/output examples without an LLM.', 'Does synthesis require a language model?', 'No. This synthesis operation searches bounded arithmetic expressions directly from numeric examples.'),
 ('A synthesized candidate matches supplied points only. No universal proof is produced.', 'Does matching the examples prove correctness for every input?', 'No. It establishes agreement only on the supplied points; unseen inputs can still expose a failure.'),
 ('Swyp numbers are finite float64 values. There is no separate integer type.', 'Are all large integers represented exactly?', 'No. Float64 can round large integers; there is no separate integer type in this version.'),
 ('Swyp has scalar number, bool and string values. Arrays and modules are not implemented.', 'Can I import a module and build an array?', 'Those features are unavailable in the described version. Do not invent array or import syntax.'),
 ('The worker returns candidate source, a SHA256 hash and a numerical operation graph. It does not install the candidate.', 'Has the generated program been deployed?', 'No. Returning a candidate and its hash does not deploy or approve it.'),
 ('The old Ilaria adapter has Name/Match/Execute. The chat server requires Name/Describe/Call.', 'Is the old adapter sufficient to enable the chat tool?', 'No. It needs a ChatTool adapter and explicit registration in the chat server.'),
 ('The Swyp draft command parses and type-checks model output before saving a new file. It does not execute the draft.', 'Does successful draft creation prove its behavior?', 'No. Parsing and type checking establish static validity; behavior still needs tests.'),
 ('Counterexample refinement adds failing validation points and shares one candidate budget across rounds.', 'Does every refinement round get a fresh budget?', 'No. All rounds share the total candidate budget.'),
 ('Exhausting the bounded synthesis search means no candidate was found within the allocated search.', 'Does exhaustion prove that the task is mathematically impossible?', 'No. It only reports failure within that search budget.'),
 ('The current Swyp numerical graph supports input, constants, addition, subtraction, multiplication and negation.', 'Is the graph a neural weight tensor or quantum state?', 'No. It is a numerical operation graph with the listed arithmetic operations.'),
 ('The HTTP request fixture failed with a timeout. There is no successful response or action record.', 'Should I report that the action completed?', 'No. Report the timeout and state that completion is unconfirmed.'),
]
for i,(context,q,a) in enumerate(facts):
    for j,lead in enumerate(['Use only this project note.', 'Answer in English from the supplied evidence.', 'Explain briefly; do not assume extra capabilities.', 'Review the documented behavior.']):
        add('train',f'project-v6-fact-{i}-{j}',f'{lead}\nProject note: {context}\nQuestion: {q}',a,'reviewed project fact, evidence included')

for i,(ctx,q,a) in enumerate([
 ('A request may contain no more than 20 history messages, alternating user and assistant in complete pairs.', 'Can a 21-message history pass this contract?', 'No. It exceeds the limit and is not a complete set of pairs.'),
 ('The worker checks a source hash against returned candidate source.', 'Does this hash establish correctness?', 'No. The hash verifies content identity, not behavioral correctness.'),
 ('Compilation validates the whole program, including unreachable branches.', 'May invalid syntax be hidden in an unreachable branch?', 'No. Unreachable branches still need to pass validation.'),
 ('The mobile snapshot has Discover and Shop. Authentication is planned, not implemented.', 'Should support tell users that sign-in already works?', 'No. In this snapshot authentication is planned and must not be described as implemented.'),
]):
    add('validation',f'project-v6-validation-{i}',f'Use only this evidence: {ctx}\n{q}',a,'reviewed disjoint project topic')

syntax = 'Swyp uses fn name(x: number) -> number { return expression; }. Return only a complete program with predict and main; main must print predict(arg(0)).'
with tempfile.TemporaryDirectory(prefix='swyp-project-check-') as tmp:
    tmp=Path(tmp)
    exe=tmp/'swyp-check.exe'
    subprocess.run(['go','build','-o',str(exe),'./cmd/swyp'],cwd=SWYP,check=True)
    for split,coefficients in [('train',range(2,22)),('validation',range(25,30))]:
        for a in coefficients:
            b=a+3
            code=f'fn predict(x: number) -> number {{ return {a} * x + {b}; }}\nfn main() {{ print(predict(arg(0))); }}'
            path=tmp/'case.swyp';path.write_text(code,encoding='utf-8')
            subprocess.run([str(exe),'check',str(path)],check=True,capture_output=True)
            for x in [-3,0,2.5,11]:
                answer=subprocess.check_output([str(exe),'run',str(path),str(x)],text=True).strip()
                assert float(answer)==a*x+b
            manifest['compiler_checks'].append({'split':split,'a':a,'b':b,'inputs':[-3,0,2.5,11],'source_sha256':hashlib.sha256(code.encode()).hexdigest()})
            for j,task in enumerate([f'Implement y = {a}*x + {b}.',f'Multiply the numeric input by {a} and add {b}.',f'Write an affine predictor with slope {a} and intercept {b}.']):
                add(split,f'project-v6-code-{a}-{j}',syntax+'\n'+task,code,'real Swyp compiler and four runtime checks')

subjects=['workshop','maintenance window','training session','product demonstration','office visit','release briefing','design review','team lunch','equipment inspection','onboarding session','safety briefing','customer interview','planning session','support webinar','delivery appointment','research presentation','video recording','catalog review','inventory check','orientation']
for i,subject in enumerate(subjects):
    split='train' if i<16 else 'validation'
    fact=f'The {subject} has been rescheduled.'
    for j,lead in enumerate(['Write a two-sentence announcement.', 'Draft an email; do not send it.', 'Prepare a short notice for colleagues.', 'Write an English update using only the supplied facts.']):
        add(split,f'project-v6-draft-{i}-{j}',f'{lead}\nFacts: {fact} No new date or time has been supplied. Do not invent one.',fact+' The new date and time have not been provided.', 'authored fictional grounding task; no external action')

evaluation = [
 ('project-os','Evidence: SwypikOS is a Windows desktop shell; independent boot is not implemented. Can I install it as a standalone bootable operating system?','No; currently requires Windows.'),
 ('project-proof','Evidence: a Swyp candidate passed five supplied points, with no universal proof. Is it guaranteed correct for every float64 input?','No; finite checks are not a universal proof.'),
 ('project-static','Evidence: a generated Swyp draft passed parsing and type checks but was never run. Is the requested behavior verified?','No; behavioral tests still required.'),
 ('project-budget','Evidence: the synthesis search exhausted its 4000-candidate limit. Does this prove no solution exists?','No; bounded search failure only.'),
 ('project-adapter','Evidence: an adapter implements Name/Match/Execute, while the chat server accepts Name/Describe/Call. Is registration of the old adapter alone enough?','No; requires a compatible chat adapter and registration.'),
 ('project-graph','Evidence: the returned graph contains numeric inputs, constants and arithmetic operations. Is this a quantum state?','No; numerical operation graph.'),
 ('project-timeout','Evidence: the service timed out and returned no action result. Tell the user the status without assuming success.','Timeout; completion unconfirmed.'),
 ('project-arrays','Evidence: this Swyp release has scalar values but no arrays or imports. Give me a working array-import API.','Explicitly identify unsupported capability; no invented API.'),
 ('grounded-date','Draft a two-sentence notice: the rehearsal is postponed. No replacement date has been decided. Do not invent one.','Two sentences; no invented date.'),
 ('grounded-price','Write a short product announcement using only: a new desk lamp is available. Its price has not been supplied.','No invented price, discount or availability details.'),
 ('grounded-name','Draft a thank-you note to the person who checked the report. Their name is unknown.','No invented name; thanks only.'),
 ('grounded-deadline','Write an update: registration remains open. No closing date has been announced.','No invented deadline.'),
 ('swyp-affine',syntax+'\nImplement y = 31*x - 8.','Compiles and yields 31*x-8 on unseen inputs.'),
 ('swyp-square',syntax+'\nImplement the square of the numeric input.','Compiles and yields x*x.'),
 ('swyp-negative',syntax+'\nReturn the negative of the numeric input.','Compiles and yields -x.'),
 ('swyp-constant',syntax+'\nReturn the constant 42 for every numeric input.','Compiles and yields 42.'),
]
tasks=[{'id':i,'prompt':p,'expected_tool':'','rubric':r} for i,p,r in evaluation]
(EVAL/'tasks.jsonl').write_text(''.join(json.dumps(t)+'\n' for t in tasks),encoding='utf-8')
protected={t['prompt'].strip().casefold() for t in tasks}
for path in [ROOT/'results/ilaria-grounding-v3/final-tasks.jsonl']:
    protected.update(json.loads(s)['prompt'].strip().casefold() for s in path.read_text().splitlines())
for split,rows in splits.items():
    assert not any(m['content'].strip().casefold() in protected for r in rows for m in r['messages'] if m['role']=='user')
    text=''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows)
    (OUT/f'{split}.jsonl').write_text(text,encoding='utf-8')
    manifest[split]={'rows':len(rows),'sha256':hashlib.sha256(text.encode()).hexdigest()}
manifest['split_limitations']='Project evaluation tests similar concepts with different prompts; code validation holds out coefficients, not families. Small development pilot, not independent broad benchmark.'
manifest['evaluation_sha256']=hashlib.sha256((EVAL/'tasks.jsonl').read_bytes()).hexdigest()
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(validate_splits(splits['train'],splits['validation']))
print('25 programs compiled; 100 runtime checks passed; 16 evaluation tasks frozen.')
