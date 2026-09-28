"""Further regression tests: checkpoint resume, malformed NXTF, stream validation."""
from __future__ import annotations
import copy
import json
import os
from pathlib import Path
import random
import struct
import subprocess
import sys

import numpy as np
import pytest
import torch

import nxtf
import train_ilaria as train
from ilaria_model import IlariaConfig, IlariaTransformer
from training_state import capture_rng, restore_rng, make_checkpoint, restore_checkpoint


def tiny():
    return IlariaTransformer(IlariaConfig(vocab_size=16, embed_dim=8, num_heads=2,
        num_layers=1, ffn_dim=16, max_seq_len=8, dropout_rate=0.2))


def header_bytes(updates=None):
    h = {'version': 2, 'config': tiny().cfg.to_go_json(), 'use_tied_weights': True}
    if updates:
        updates(h)
    raw = json.dumps(h).encode()
    return nxtf.MAGIC + struct.pack('<I', len(raw)) + raw


@pytest.mark.parametrize('change,match', [
    (lambda h: h.update(version=3), 'version'),
    (lambda h: h.update(version=True), 'version'),
    (lambda h: h.update(use_tied_weights=False), 'tied'),
    (lambda h: h['config'].update(embed_dim=7), 'divisible'),
    (lambda h: h['config'].update(num_heads=0), 'field'),
    (lambda h: h['config'].update(num_layers=5000), 'layer'),
    (lambda h: h['config'].update(vocab_size=10**12), 'budget'),
    (lambda h: h['config'].update(eos_token_id=100), 'EOS'),
    (lambda h: h['config'].update(use_rope='yes'), 'boolean'),
    (lambda h: h['config'].update(dropout_rate=float('nan')), 'dropout'),
    (lambda h: h['config'].update(embed_dim=6, use_rope=True), 'even'),
])
def test_bad_headers_before_allocation(tmp_path, monkeypatch, change, match):
    p=tmp_path/'bad.nxtf'; p.write_bytes(header_bytes(change))
    monkeypatch.setattr(nxtf, 'IlariaTransformer', lambda _: pytest.fail('allocated malformed model'))
    with pytest.raises(ValueError, match=match): nxtf.load_nxtf(p)


@pytest.mark.parametrize('payload,match', [
    (b'x', 'truncated'),
    (b'NOPE1234', 'not an'),
    (nxtf.MAGIC + struct.pack('<I', 999999), 'header'),
    (nxtf.MAGIC + struct.pack('<I', 1) + b'{', 'JSON'),
])
def test_invalid_nxtf_prefixes(tmp_path, payload, match):
    p=tmp_path/'bad.nxtf';p.write_bytes(payload)
    with pytest.raises(ValueError, match=match): nxtf.load_nxtf(p)


def test_truncated_rank_and_trailing(tmp_path, monkeypatch):
    p=tmp_path/'a.nxtf';nxtf.save_nxtf(tiny(),p); valid=p.read_bytes()
    monkeypatch.setattr(nxtf, 'IlariaTransformer', lambda _: pytest.fail('allocated invalid model'))
    for changed, match in [(valid[:-1], 'truncated'), (valid+b'x','trailing')]:
        p.write_bytes(changed)
        with pytest.raises(ValueError, match=match): nxtf.load_nxtf(p)
    offset=12+struct.unpack('<I',valid[8:12])[0]
    p.write_bytes(valid[:offset]+struct.pack('<I',999999)+valid[offset+4:])
    with pytest.raises(ValueError, match='rank'): nxtf.load_nxtf(p)


def test_loader_checks_under_python_optimization(tmp_path):
    p=tmp_path/'bad.nxtf';p.write_bytes(b'BADMAGIC'+b'\0'*8)
    code='import nxtf,sys\ntry: nxtf.load_nxtf(sys.argv[1])\nexcept ValueError: sys.exit(0)\nsys.exit(1)'
    r=subprocess.run([sys.executable,'-O','-c',code,str(p)],cwd=Path(__file__).parent,
                     capture_output=True,text=True,timeout=20)
    assert r.returncode==0, r.stderr


def test_rng_restore():
    random.seed(42);torch.manual_seed(42);rng=np.random.default_rng(42)
    state=capture_rng(rng)
    expected=(random.random(),torch.rand(3),rng.integers(100,size=3))
    restore_rng(state,rng)
    actual=(random.random(),torch.rand(3),rng.integers(100,size=3))
    assert expected[0]==actual[0]
    assert torch.equal(expected[1],actual[1])
    assert np.array_equal(expected[2],actual[2])


def test_checkpoint_compatibility_before_mutation():
    m=tiny();opt=torch.optim.AdamW(m.parameters());scaler=torch.amp.GradScaler('cuda',enabled=False)
    rng=np.random.default_rng(2);sig={'arguments':{'steps':5}, 'data_sha256':'abc'}
    ck=make_checkpoint(m,opt,scaler,rng,2,1.0,32,sig)
    for change,match in [(lambda c: c.update(schema_version=0),'schema'),
                         (lambda c: c.update(signature={}),'signature'),
                         (lambda c: c['cfg'].update(dropout_rate=0),'configuration')]:
        bad=copy.deepcopy(ck);change(bad)
        before={k:v.clone() for k,v in m.state_dict().items()}
        with pytest.raises(ValueError,match=match):restore_checkpoint(bad,m,opt,scaler,rng,sig)
        assert all(torch.equal(v,m.state_dict()[k]) for k,v in before.items())


@pytest.mark.parametrize('body,meta', [
    (b'\x00', {'dtype':'uint16','vocab_size':16,'eos_id':3}),
    (b'', {'dtype':'uint16','vocab_size':16,'eos_id':3}),
    (b'\xff\xff', {'dtype':'uint16','vocab_size':16,'eos_id':3}),
    (b'\x00\x00', {'dtype':'uint16','vocab_size':True,'eos_id':0}),
])
def test_invalid_token_stream(tmp_path,body,meta):
    p=tmp_path/'stream';p.with_suffix('.bin').write_bytes(body)
    p.with_suffix('.json').write_text(json.dumps(meta))
    with pytest.raises(ValueError):train.load_stream(str(p))


def _equal_tree(a,b):
    if isinstance(a,torch.Tensor):return torch.equal(a,b)
    if isinstance(a,dict):return a.keys()==b.keys() and all(_equal_tree(a[k],b[k]) for k in a)
    if isinstance(a,(tuple,list)):return len(a)==len(b) and all(_equal_tree(x,y) for x,y in zip(a,b))
    return a==b


@pytest.mark.parametrize("eval_every,stop_after", [(1,2),(3,2)])
def test_actual_trainer_resume_with_dropout(tmp_path,eval_every,stop_after):
    prefix=tmp_path/'tokens'
    np.random.default_rng(9).integers(0,16,600,dtype=np.uint16).tofile(prefix.with_suffix('.bin'))
    prefix.with_suffix('.json').write_text(json.dumps({'dtype':'uint16','vocab_size':16,'eos_id':3}))
    common=[sys.executable,str(Path(__file__).with_name('train_ilaria.py')),'--data',str(prefix),
        '--embed-dim','8','--heads','2','--layers','1','--ffn-dim','16','--ctx','4','--max-seq-len','8',
        '--batch','2','--accum','2','--steps','4','--warmup','1','--eval-every',str(eval_every),'--eval-iters','1',
        '--dropout','0.2','--precision','fp32','--seed','17']
    env=dict(os.environ,OMP_NUM_THREADS='1',MKL_NUM_THREADS='1')
    full,split=tmp_path/'full',tmp_path/'split'
    for extras in [['--out',str(full)],['--out',str(split),'--stop-after',str(stop_after)],
                   ['--out',str(split),'--resume',str(split/'checkpoint.pt')]]:
        res=subprocess.run(common+extras,env=env,capture_output=True,text=True,timeout=25)
        assert res.returncode==0,res.stderr+'\n'+res.stdout
    a=torch.load(full/'checkpoint.pt',weights_only=True)
    b=torch.load(split/'checkpoint.pt',weights_only=True)
    assert a['step']==b['step']==4
    assert a['tokens_seen']==b['tokens_seen']==64
    for key in ['model','opt','rng','scaler','best_val','signature']:
        assert _equal_tree(a[key],b[key]),key
    assert (full/'transformer.nxtf').read_bytes()==(split/'transformer.nxtf').read_bytes()


def test_legacy_weight_initialization():
    from training_state import initialize_weights
    a,b=tiny(),tiny()
    initialize_weights({'model':a.state_dict(),'cfg':a.cfg.__dict__},b)
    assert _equal_tree(a.state_dict(),b.state_dict())
    with pytest.raises(ValueError):initialize_weights({'model':a.state_dict(),'cfg':{}},b)
