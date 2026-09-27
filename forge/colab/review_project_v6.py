"""Record manual semantic decisions alongside executable Swyp checks."""
import hashlib
import json
from pathlib import Path

root=Path(__file__).resolve().parents[2]/'results/ilaria-project-v6'
before=json.loads((root/'before-answers.json').read_text(encoding='utf-8'))
after=json.loads((root/'after-answers.json').read_text(encoding='utf-8'))
assert len(before)==16 and len(after)==74
baseline_pass={'project-os','project-budget','project-timeout','grounded-date','grounded-price','grounded-deadline'}
new_fail={
 'project-static':'Deflects to unavailable tools instead of explaining that static validity does not verify behavior.',
 'project-budget':'Contradicts supplied evidence that the search exhausted its budget.',
 'project-adapter':'Invents a Name/Execute/Call contract instead of the supplied Name/Describe/Call contract.',
 'project-arrays':'Unrelated capital-of-France response rather than identifying unavailable arrays/imports.',
 'grounded-name':'Does not provide the requested thank-you note.',
 'swyp-negative':'Behavior correct on six inputs, but uses negative instead of the explicitly required predict function.',
}
regression_fail={
 'fresh-target':'Guesses meters and calls conversion despite missing destination unit.',
 'transfer-replacement':'Refuses sending instead of providing the requested draft.',
 'transfer-subject':'Asks for email content instead of generating the requested subject.',
 'transfer-unit':'Asks for a Fahrenheit temperature instead of the missing source unit.',
}
decisions=[]
for row in after:
    failure={**new_fail,**regression_fail}.get(row['id'])
    decisions.append({'id':row['id'],'pass':failure is None,'reason':failure or 'Meets the semantic task requirement.','generation':row['generation']})
review={'method':'Manual, non-blinded semantic review; code checked by real compiler and six interpreter inputs. Not an automated language judge.',
 'scores':{'v5_project':6,'v6_project':10,'project_total':16,'v5_english_regression':57,'v6_english_regression':54,'regression_total':58},
 'baseline_project_pass_ids':sorted(baseline_pass),'v6_cases':decisions,
 'code_behavior':'v6 4/4 compile and pass all 24 numerical checks; 3/4 also satisfy the explicit function-name contract. v5 0/4 compile.',
 'decision':'Do not promote v6 as default: project/code improvement accompanied by English regressions. Preserve v5 reference and v6 experimental export.',
 'limitations':['Small synthetic development set; project concepts overlap training themes.', 'Regression ceiling increased from 128 to 256 tokens; comparisons are not perfectly identical.', 'Python and Go generations differ on some prose; final decisions use Go outputs.', 'No Swyp chat tool registration, deployment, or broad math/science validation.'],
 'after_sha256':hashlib.sha256((root/'after-answers.json').read_bytes()).hexdigest()}
(root/'manual-review.json').write_text(json.dumps(review,indent=2,ensure_ascii=False),encoding='utf-8')
p=root/'run-summary.json';summary=json.loads(p.read_text())
summary.update({'status':'Training, export verification and Go evaluation complete; not promoted due to regressions','scores':review['scores'],'code_pass':3,'code_total':4,'false_calls':1,'no_tool_cases':39})
p.write_text(json.dumps(summary,indent=2),encoding='utf-8')
print('Review saved: project 10/16; regression 54/58; v6 remains experimental.')
