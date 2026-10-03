"""Pure metadata/deadline regressions and real owned non-model Windows children."""
import copy
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

spec = importlib.util.spec_from_file_location('consent_runner', Path(__file__).with_name('verify-imc-consent-revocation.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


@pytest.fixture
def metadata():
    keys = {name: Ed25519PrivateKey.generate() for name in ('issuer', 'proposer', 'evaluator')}
    public = {name: key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
              for name, key in keys.items()}
    progress = {'session': 'a' * 64, 'genesis': 'b' * 64, 'parent': 'b' * 64, 'lineage': 'b' * 64, 'sequence': 0}
    nonce = 'c' * 64
    reservations = ['used-' + hashlib.sha256((progress['session'] + value).encode()).hexdigest()
                    for value in ('round-1', nonce)]
    state = {'issuer': {'progress': {'value': progress, 'sha256': 'd' * 64},
                        'active': {'value': progress['genesis'], 'sha256': 'e' * 64},
                        'pending': None, 'reservations': [], 'committed_versions': [], 'history_versions': ['history-0.json']},
             'proposer': {'progress': None, 'active': None, 'pending': None, 'reservations': reservations,
                          'committed_versions': [], 'history_versions': []}}
    config = {'d_model': 32, 'eos_token_id': 15, 'ffn_dim': 64, 'max_seq_len': 8,
              'n_heads': 4, 'n_kv_heads': 2, 'n_layers': 1, 'vocab_size': 16}
    recipe = {'config': config, 'learning_rate': .001, 'max_delta_norm': 20., 'min_improvement': .0001,
              'seed': 1701, 'steps': 64, 'version': 1}
    fixture = {}
    for split, starts in [('train', range(0, 6)), ('eval', range(6, 10)), ('anchors', range(10, 14)), ('sealed', range(14, 15))]:
        ids = [[(start + i) % 15 for i in range(8)] for start in starts]
        fixture[split] = [ids, [row[1:] + [15] for row in ids]]
    job = {'protocol_version': 2, 'issuer_id': 'issuer', 'expert_id': 'synthetic-imc',
           'session_id': progress['session'], 'round_sequence': 1, 'round_id': 'round-1',
           'genesis_checkpoint_hash': progress['genesis'], 'current_parent_checkpoint_hash': progress['parent'],
           'lineage_hash': progress['lineage'], 'model_config_hash': hashlib.sha256(runner.canonical(config)).hexdigest(),
           'curriculum_manifest_hash': hashlib.sha256(runner.canonical(fixture)).hexdigest(), 'dataset_scope': runner.CONSENT['scope'],
           'authorized_purpose': runner.CONSENT['purpose'], 'training_recipe_hash': hashlib.sha256(runner.canonical(recipe)).hexdigest(),
           'recipe_json': runner.canonical(recipe).decode(), 'proposer_id': 'proposer', 'evaluator_id': 'evaluator',
           'proposer_key_hash': hashlib.sha256(bytes.fromhex(public['proposer'])).hexdigest(),
           'evaluator_key_hash': hashlib.sha256(bytes.fromhex(public['evaluator'])).hexdigest(),
           'nonce': nonce, 'consent_epoch': 1, 'lease_fence': 1, 'deadline_unix_ms': 100000}
    signed = runner.canonical(job)
    marker = {'version': 1, 'phase': 'after-first-optimizer-step', 'step': 1, 'worker_pid': 123,
              'issued_job_hash': hashlib.sha256(signed).hexdigest(), 'current_parent_checkpoint_hash': progress['parent'],
              'signed_job': signed.decode(), 'issuer_signature': keys['issuer'].sign(signed).hex(),
              'created_unix_ms': 10000, 'monotonic_ns': 15_000_000_000, 'hold_ms': 1000}
    first = {'pid': 123, 'created_100ns': 116444736000000000, 'cpu_ns': 1000, 'monotonic': 14., 'alive': True}
    second = dict(first, cpu_ns=2000, monotonic=16.)
    return state, marker, keys, public, first, second


def validate(data):
    state, marker, _, public, first, second = data
    verified = runner.validate_phase(runner.canonical(marker), state, second, public['issuer'], public['proposer'], public['evaluator'])
    return runner.validate_activity(first, second, state, verified)


def test_signed_real_step_metadata_acceptance(metadata):
    result = validate(metadata)
    assert result['cpu_delta_ns'] == 1000 and result['worker_pid'] == 123
    assert runner.validate_no_publication(metadata[0], copy.deepcopy(metadata[0]))['pending'] == 'ABSENT'


@pytest.mark.parametrize('fault', ['cpu-only', 'same-cpu', 'pid-reused', 'pid-changed', 'time-reversed', 'marker-before', 'marker-after', 'no-reservation', 'worker-dead'])
def test_active_observation_never_inferred_from_cpu_only(metadata, fault):
    state, marker, _, _, first, second = metadata
    if fault == 'same-cpu': second['cpu_ns'] = first['cpu_ns']
    if fault == 'pid-reused': second['created_100ns'] += 1
    if fault == 'pid-changed': second['pid'] += 1
    if fault == 'time-reversed': second['monotonic'] = first['monotonic']
    if fault == 'marker-before': marker['monotonic_ns'] = 13_000_000_000
    if fault == 'marker-after': marker['monotonic_ns'] = 17_000_000_000
    if fault == 'no-reservation': state['proposer']['reservations'] = []
    if fault == 'worker-dead': second['alive'] = False
    with pytest.raises(runner.Unproved):
        runner.validate_activity(first, second, state, None if fault == 'cpu-only' else marker)


@pytest.mark.parametrize('fault', ['signature', 'job-hash', 'pid', 'pre-step', 'phase-setup', 'hold-large', 'bool-step', 'byte-bound', 'extra', 'nonce', 'epoch', 'parent', 'recipe', 'scope', 'deadline', 'foreign-authority', 'fixture', 'bool-epoch'])
def test_corrupt_or_resigned_phase_metadata_denied(metadata, fault):
    _, marker, keys, _, _, _ = metadata
    if fault == 'signature': marker['issuer_signature'] = '00' * 64
    if fault == 'job-hash': marker['issued_job_hash'] = '00' * 32
    if fault == 'pid': marker['worker_pid'] += 1
    if fault == 'pre-step': marker['step'] = 0
    if fault == 'phase-setup': marker['phase'] = 'optimizer-created'
    if fault == 'hold-large': marker['hold_ms'] = 1001
    if fault == 'bool-step': marker['step'] = True
    if fault == 'byte-bound': marker['signed_job'] += ' ' * 4096
    if fault == 'extra': marker['local_vars'] = {}
    if fault in ('nonce', 'epoch', 'parent', 'recipe', 'scope', 'deadline', 'foreign-authority', 'fixture', 'bool-epoch'):
        job = runner.strict_json(marker['signed_job'])
        field, value = {'nonce': ('nonce', '0' * 64), 'epoch': ('consent_epoch', 2), 'parent': ('current_parent_checkpoint_hash', '0' * 64),
                        'recipe': ('recipe_json', '{}'), 'scope': ('dataset_scope', 'private'), 'deadline': ('deadline_unix_ms', 10000),
                        'foreign-authority': ('issuer_id', 'foreign'), 'fixture': ('curriculum_manifest_hash', '0' * 64),
                        'bool-epoch': ('consent_epoch', True)}[fault]
        job[field] = value
        signed = runner.canonical(job)
        marker.update(signed_job=signed.decode(), issued_job_hash=hashlib.sha256(signed).hexdigest(),
                      issuer_signature=keys['issuer'].sign(signed).hex())
    from cryptography.exceptions import InvalidSignature
    with pytest.raises((ValueError, InvalidSignature)): validate(metadata)


@pytest.mark.parametrize('fault', ['progress', 'active', 'commit', 'history', 'more-work', 'pending'])
def test_post_revocation_update_or_uncertainty_not_success(metadata, fault):
    before = metadata[0]
    after = copy.deepcopy(before)
    if fault == 'progress': after['issuer']['progress']['value']['sequence'] = 1
    if fault == 'active': after['issuer']['active']['value'] = 'f' * 64
    if fault == 'commit': after['issuer']['committed_versions'] = ['committed-1.json']
    if fault == 'history': after['proposer']['history_versions'] = ['history-1.json']
    if fault == 'more-work': after['proposer']['reservations'].append('used-' + 'f' * 64)
    if fault == 'pending': after['issuer']['pending'] = {'value': {'after': {'sequence': 1}}}
    with pytest.raises((ValueError, runner.Unproved)):
        runner.validate_no_publication(before, after)


def test_atomic_revocation_only_fresh_declared_consent(tmp_path):
    path = tmp_path / 'consent.json'
    path.write_bytes(runner.canonical(runner.CONSENT))
    result = runner.atomic_revoke(tmp_path)
    assert runner.strict_json(path.read_bytes()) == dict(runner.CONSENT, opt_in=False)
    assert result['consent_sha256'] == runner.sha(path)
    assert not (tmp_path / 'consent-revoked.tmp').exists()
    with pytest.raises(ValueError): runner.atomic_revoke(tmp_path)


def test_scalar_metadata_never_reads_checkpoint_payload(tmp_path, monkeypatch, metadata):
    issuer, proposer = tmp_path / 'issuer', tmp_path / 'proposer'
    issuer.mkdir(); proposer.mkdir()
    progress = metadata[0]['issuer']['progress']['value']
    (issuer / 'progress.json').write_bytes(runner.canonical(progress))
    (issuer / 'active.json').write_text(progress['parent'])
    (issuer / (progress['parent'] + '.json')).write_bytes(b'not allowed to read')
    for name in metadata[0]['proposer']['reservations']: (proposer / name).write_bytes(b'reserved')
    original = runner.read_small
    def limited(path, maximum=runner.METADATA_BYTES):
        assert Path(path).name != progress['parent'] + '.json'
        return original(path, maximum)
    monkeypatch.setattr(runner, 'read_small', limited)
    assert runner.validate_initial(runner.scalar_state(issuer, proposer))


def test_duplicate_nonfinite_and_metadata_byte_limits(tmp_path):
    with pytest.raises(ValueError): runner.strict_json(b'{"x":1,"x":2}')
    with pytest.raises(ValueError): runner.strict_json(b'{"x":NaN}')
    path = tmp_path / 'metadata.json'; path.write_bytes(b'a' * 17)
    with pytest.raises(ValueError): runner.read_small(path, 16)


def test_shared_budget_cumulative_utc_monotonic_and_cleanup():
    helper = runner.load_helpers(Path(__file__).resolve().parents[2])
    ticks = [0.]
    utc = [datetime(2026, 10, 2, tzinfo=timezone.utc)]
    budget = helper.Budget(utc[0] + timedelta(seconds=115), 115, 10,
                           monotonic=lambda: ticks[0], utc=lambda: utc[0])
    assert budget.allowance(200) == 105
    ticks[0] = 103
    assert budget.allowance(200) == 2
    ticks[0] = 105
    with pytest.raises(TimeoutError): budget.allowance(1)
    assert budget.allowance(20, cleanup=True) == 10
    utc[0] += timedelta(seconds=116)
    with pytest.raises(TimeoutError): budget.allowance(1, cleanup=True)


@pytest.mark.skipif(os.name != 'nt', reason='real Windows Job identity containment')
def test_owned_windows_job_stops_root_and_descendant_while_callback_held(tmp_path):
    job = runner.WindowsJob(cpu=25, memory=256 << 20, processes=2)
    process = None
    drain = None
    try:
        ready = tmp_path / 'owned-ready.json'
        child = 'import os,json\nwith open(' + repr(str(ready)) + ',"x") as f:f.write(json.dumps({"pid":os.getpid()}))\nx=0\nwhile True:\n x=(x+1)%1000000\n'
        code = 'import subprocess,sys,time\np=subprocess.Popen([sys.executable,"-I","-u","-c",' + repr(child) + '],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=sys.stdout,creationflags=subprocess.CREATE_NO_WINDOW)\ntime.sleep(30)\n'
        process = subprocess.Popen([sys.executable, '-I', '-u', '-c', code], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   creationflags=subprocess.CREATE_NO_WINDOW | 0x4)
        helper = runner.load_helpers(Path(__file__).resolve().parents[2])
        drain = helper.BoundedOutput(process.stdout, tmp_path / 'owned-child.log')
        job.assign_resume(process)
        job.sample(process.pid)
        end = time.monotonic() + 10
        while not ready.exists() and time.monotonic() < end: time.sleep(.01)
        assert ready.exists(), (drain.text(), [job.sample(pid) for pid in job.pids()])
        pids = job.pids()
        assert process.pid in pids
        worker = runner.strict_json(ready.read_bytes())['pid']
        assert worker in pids and worker != process.pid
        for pid in pids: job.sample(pid)
        images = {pid: job.image_name(pid) for pid in job.alive_pids()}
        assert {pid for pid, name in images.items() if name == Path(sys.executable).name.lower()} == {process.pid, worker}, images
        first = job.sample(worker)
        assert first['alive']
        while job.sample(worker)['cpu_ns'] <= first['cpu_ns'] and time.monotonic() < end: time.sleep(.01)
        second = job.sample(worker)
        assert second['created_100ns'] == first['created_100ns'] and second['cpu_ns'] > first['cpu_ns'], (second, drain.text())
        started = time.monotonic()
        assert job.close() is None
        process.wait(timeout=2)
        for pid in pids:
            while job.sample(pid)['alive'] and time.monotonic() - started < 2: time.sleep(.01)
            assert not job.sample(pid)['alive']
        # The test callback remains active here; its process tree is already gone.
        assert time.monotonic() - started < 2
        assert job.close() is None
    finally:
        job.close()
        if process is not None and process.poll() is None:
            process.kill(); process.wait(timeout=2)
        if drain is not None:
            drain.thread.join(timeout=2)
            assert not drain.thread.is_alive()
        job.release_handles()
