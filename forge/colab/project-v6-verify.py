assert rc_v6 == 0
from safetensors import safe_open
meta_v6=json.loads((RUN_V6/'adapter-step200.json').read_text())
assert meta_v6['contract']['encoding_version']=='assistant-header-split-v2'
assert meta_v6['contract']['initial_adapter']['weights_sha256']=='1a275f6a5541da2cc942d25c6bd7530fcfbb74c17c501cf0e49a1efbca4e8446'
with safe_open(str(RUN_V6/'adapter-step200.safetensors'),framework='pt',device='cpu') as sf:
    assert len(list(sf.keys()))==420
    for key in sf.keys():
        assert torch.isfinite(sf.get_tensor(key)).all()
artifacts_v6={n:hashlib.sha256((RUN_V6/n).read_bytes()).hexdigest() for n in ['checkpoint.pt','adapter-step200.json','adapter-step200.safetensors']}
(RUN_V6/'artifact_manifest.json').write_text(json.dumps(artifacts_v6,indent=2))
print('VERIFIED V6: 200 steps; 420 finite tensors; parent and encoding confirmed')
print(json.dumps(artifacts_v6))
import shutil
for suffix in ['json','safetensors']:
    shutil.copyfile(RUN_V6/('adapter-step200.'+suffix),Path('/content/ilaria-project-v6.'+suffix))
sys.path.insert(0,str(WORK/'forge/multimodal'))
import lora_bitlinear as lb
from forge.train_tools import initialize_adapter
probe_tok=AutoTokenizer.from_pretrained(str(MODEL),local_files_only=True)
probe_model=lb.load_frozen_base('offline',str(MODEL)).to('cuda')
lb.inject_lora(probe_model,r=16,alpha=32,dropout=0)
probe_model.to('cuda')
initialize_adapter(probe_model,str(RUN_V6/'adapter-step200'),lb,'offline',16,32)
probe_model.eval()
project_tasks=json.loads("[{\"id\":\"project-os\",\"prompt\":\"Evidence: SwypikOS is a Windows desktop shell; independent boot is not implemented. Can I install it as a standalone bootable operating system?\",\"expected_tool\":\"\",\"rubric\":\"No; currently requires Windows.\"},{\"id\":\"project-proof\",\"prompt\":\"Evidence: a Swyp candidate passed five supplied points, with no universal proof. Is it guaranteed correct for every float64 input?\",\"expected_tool\":\"\",\"rubric\":\"No; finite checks are not a universal proof.\"},{\"id\":\"project-static\",\"prompt\":\"Evidence: a generated Swyp draft passed parsing and type checks but was never run. Is the requested behavior verified?\",\"expected_tool\":\"\",\"rubric\":\"No; behavioral tests still required.\"},{\"id\":\"project-budget\",\"prompt\":\"Evidence: the synthesis search exhausted its 4000-candidate limit. Does this prove no solution exists?\",\"expected_tool\":\"\",\"rubric\":\"No; bounded search failure only.\"},{\"id\":\"project-adapter\",\"prompt\":\"Evidence: an adapter implements Name/Match/Execute, while the chat server accepts Name/Describe/Call. Is registration of the old adapter alone enough?\",\"expected_tool\":\"\",\"rubric\":\"No; requires a compatible chat adapter and registration.\"},{\"id\":\"project-graph\",\"prompt\":\"Evidence: the returned graph contains numeric inputs, constants and arithmetic operations. Is this a quantum state?\",\"expected_tool\":\"\",\"rubric\":\"No; numerical operation graph.\"},{\"id\":\"project-timeout\",\"prompt\":\"Evidence: the service timed out and returned no action result. Tell the user the status without assuming success.\",\"expected_tool\":\"\",\"rubric\":\"Timeout; completion unconfirmed.\"},{\"id\":\"project-arrays\",\"prompt\":\"Evidence: this Swyp release has scalar values but no arrays or imports. Give me a working array-import API.\",\"expected_tool\":\"\",\"rubric\":\"Explicitly identify unsupported capability; no invented API.\"},{\"id\":\"grounded-date\",\"prompt\":\"Draft a two-sentence notice: the rehearsal is postponed. No replacement date has been decided. Do not invent one.\",\"expected_tool\":\"\",\"rubric\":\"Two sentences; no invented date.\"},{\"id\":\"grounded-price\",\"prompt\":\"Write a short product announcement using only: a new desk lamp is available. Its price has not been supplied.\",\"expected_tool\":\"\",\"rubric\":\"No invented price, discount or availability details.\"},{\"id\":\"grounded-name\",\"prompt\":\"Draft a thank-you note to the person who checked the report. Their name is unknown.\",\"expected_tool\":\"\",\"rubric\":\"No invented name; thanks only.\"},{\"id\":\"grounded-deadline\",\"prompt\":\"Write an update: registration remains open. No closing date has been announced.\",\"expected_tool\":\"\",\"rubric\":\"No invented deadline.\"},{\"id\":\"swyp-affine\",\"prompt\":\"Swyp uses fn name(x: number) -> number { return expression; }. Return only a complete program with predict and main; main must print predict(arg(0)).\\nImplement y = 31*x - 8.\",\"expected_tool\":\"\",\"rubric\":\"Compiles and yields 31*x-8 on unseen inputs.\"},{\"id\":\"swyp-square\",\"prompt\":\"Swyp uses fn name(x: number) -> number { return expression; }. Return only a complete program with predict and main; main must print predict(arg(0)).\\nImplement the square of the numeric input.\",\"expected_tool\":\"\",\"rubric\":\"Compiles and yields x*x.\"},{\"id\":\"swyp-negative\",\"prompt\":\"Swyp uses fn name(x: number) -> number { return expression; }. Return only a complete program with predict and main; main must print predict(arg(0)).\\nReturn the negative of the numeric input.\",\"expected_tool\":\"\",\"rubric\":\"Compiles and yields -x.\"},{\"id\":\"swyp-constant\",\"prompt\":\"Swyp uses fn name(x: number) -> number { return expression; }. Return only a complete program with predict and main; main must print predict(arg(0)).\\nReturn the constant 42 for every numeric input.\",\"expected_tool\":\"\",\"rubric\":\"Compiles and yields 42.\"}]")
probe_system=train[0]['messages'][0]['content']
answers_v6=[]
for task in project_tasks:
    prompt='System: '+probe_system+'<|eot_id|>User: '+task['prompt']+'<|eot_id|>Assistant: '
    ids=probe_tok(prompt,return_tensors='pt',add_special_tokens=False).input_ids.to('cuda')
    with torch.no_grad(),torch.autocast('cuda',dtype=torch.bfloat16):
        generated=probe_model.generate(ids,attention_mask=torch.ones_like(ids),do_sample=False,max_new_tokens=256,pad_token_id=probe_tok.eos_token_id,eos_token_id=[probe_tok.eos_token_id,probe_tok.convert_tokens_to_ids('<|eot_id|>')])
    row={**task,'generation':probe_tok.decode(generated[0,ids.shape[1]:],skip_special_tokens=True)}
    answers_v6.append(row)
    print('V6ANSWER '+json.dumps(row,ensure_ascii=False),flush=True)
(RUN_V6/'python-project-evaluation.json').write_text(json.dumps(answers_v6,ensure_ascii=False,indent=2))
del probe_model
import gc
gc.collect()
torch.cuda.empty_cache()
print('V6 PYTHON CHECK COMPLETE; Go verification remains separate')
from google.colab import files
files.download('/content/ilaria-project-v6.json')
files.download('/content/ilaria-project-v6.safetensors')
