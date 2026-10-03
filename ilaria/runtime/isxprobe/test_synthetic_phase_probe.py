"""Diagnostic metadata admission and genuine-step ordering; tiny canonical IMC."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import time

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

spec = importlib.util.spec_from_file_location('phase_peer', Path(__file__).with_name('peer.py'))
peer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(peer)


@pytest.fixture
def authorized(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    recipe = copy.deepcopy(peer.RECIPE)
    recipe.update(learning_rate=.001, steps=3)
    initial = peer.model(recipe)
    parent = peer.pack(initial.state_dict())
    parent_hash = peer.digest(parent)
    private = {name: Ed25519PrivateKey.generate() for name in ('issuer', 'proposer', 'evaluator')}
    keys = {name: key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
            for name, key in private.items()}
    pins = {name + suffix: value for name in keys for suffix, value in (('_id', name), ('_key', keys[name]))}
    job = {'protocol_version': 2, 'issuer_id': 'issuer', 'expert_id': 'synthetic-imc',
           'session_id': 'a' * 64, 'round_sequence': 1, 'round_id': 'round-1',
           'genesis_checkpoint_hash': parent_hash, 'current_parent_checkpoint_hash': parent_hash,
           'lineage_hash': parent_hash, 'model_config_hash': peer.digest(recipe['config']),
           'curriculum_manifest_hash': peer.fixture_hash(), 'dataset_scope': 'synthetic-public-v1',
           'authorized_purpose': 'local-network-training', 'training_recipe_hash': peer.digest(recipe),
           'recipe_json': peer.canonical(recipe).decode(), 'proposer_id': 'proposer', 'evaluator_id': 'evaluator',
           'proposer_key_hash': peer.hashlib.sha256(bytes.fromhex(keys['proposer'])).hexdigest(),
           'evaluator_key_hash': peer.hashlib.sha256(bytes.fromhex(keys['evaluator'])).hexdigest(),
           'nonce': 'b' * 64, 'consent_epoch': 1, 'lease_fence': 1, 'deadline_unix_ms': int(time.time() * 1000) + 60000}
    signed = peer.canonical(job)
    request = {'operation': 'network-propose', 'signed_job': signed.decode(), 'signature': private['issuer'].sign(signed).hex(),
               'pins': pins, 'parent': parent}
    return request, job, private


def probe(request, hold=0):
    request['phase_probe'] = {'path': str(Path.cwd() / 'synthetic-phase.json'), 'hold_ms': hold}
    return Path(request['phase_probe']['path'])


def test_default_off_and_identical_training_output(authorized):
    request, job, _ = authorized
    default = peer.network_operation(request)
    assert not (Path.cwd() / 'synthetic-phase.json').exists()
    path = probe(request)
    observed = peer.network_operation(request)
    assert observed == default  # actual raw deltas, hashes and loss values unchanged
    marker = peer.strict_json(path.read_bytes())
    assert len(path.read_bytes()) <= 4096
    assert marker['step'] == 1 and marker['phase'] == 'after-first-optimizer-step'
    assert marker['worker_pid'] == os.getpid()
    assert marker['signed_job'] == request['signed_job'] and marker['issuer_signature'] == request['signature']
    assert marker['issued_job_hash'] == peer.hashlib.sha256(request['signed_job'].encode()).hexdigest()
    assert marker['current_parent_checkpoint_hash'] == job['current_parent_checkpoint_hash']


@pytest.mark.parametrize('failure', ['backward', 'optimizer'])
def test_no_marker_for_setup_or_failed_real_step(authorized, monkeypatch, failure):
    request, _, _ = authorized
    path = probe(request)
    def failed(*_args, **_kwargs):
        assert not path.exists()
        raise RuntimeError('real step not completed')
    if failure == 'backward':
        monkeypatch.setattr(peer.torch.Tensor, 'backward', failed)
    else:
        monkeypatch.setattr(peer.torch.optim.AdamW, 'step', failed)
    with pytest.raises(RuntimeError, match='not completed'):
        peer.network_operation(request)
    assert not path.exists()


@pytest.mark.parametrize('fault', ['foreign', 'relative', 'existing', 'symlink', 'hold-negative', 'hold-large', 'hold-bool', 'extra', 'operation'])
def test_invalid_probe_before_model_allocation(authorized, monkeypatch, tmp_path, fault):
    request, _, _ = authorized
    path = probe(request)
    if fault == 'foreign': request['phase_probe']['path'] = str(tmp_path.parent / 'foreign.json')
    if fault == 'relative': request['phase_probe']['path'] = 'synthetic-phase.json'
    if fault == 'existing': path.write_bytes(b'protected')
    if fault == 'symlink':
        try: path.symlink_to(tmp_path / 'absent-foreign')
        except OSError as exc: pytest.skip(str(exc))
    if fault.startswith('hold-'): request['phase_probe']['hold_ms'] = {'hold-negative': -1, 'hold-large': 1001, 'hold-bool': True}[fault]
    if fault == 'extra': request['phase_probe']['ambient'] = str(tmp_path.parent)
    if fault == 'operation': request['operation'] = 'network-measure'
    def allocated(*_): pytest.fail('model allocation preceded probe rejection')
    monkeypatch.setattr(peer, 'network_parent', allocated)
    with pytest.raises(ValueError): peer.network_operation(request)
    if fault == 'existing': assert path.read_bytes() == b'protected'


@pytest.mark.parametrize('field,value', [('authorized_purpose', 'other'), ('dataset_scope', 'other'),
                                       ('proposer_id', 'other'), ('consent_epoch', 2), ('round_sequence', 2)])
def test_wrong_signed_authority_refused(authorized, field, value):
    request, job, private = authorized
    probe(request)
    job[field] = value
    signed = peer.canonical(job)
    request.update(signed_job=signed.decode(), signature=private['issuer'].sign(signed).hex())
    with pytest.raises(ValueError): peer.network_operation(request)
    assert not (Path.cwd() / 'synthetic-phase.json').exists()


def test_deadline_record_byte_bound_and_no_replace(authorized, monkeypatch):
    request, job, _ = authorized
    path = probe(request)
    job['deadline_unix_ms'] = 1
    with pytest.raises(ValueError, match='deadline'): peer.record_training_phase(request['phase_probe'], request, job, 1)
    assert not path.exists()
    job['deadline_unix_ms'] = int(time.time() * 1000) + 60000
    with pytest.raises(ValueError, match='step'): peer.record_training_phase(request['phase_probe'], request, job, 0)
    monkeypatch.setattr(peer, 'PHASE_BYTES', 16)
    with pytest.raises(ValueError, match='byte'): peer.record_training_phase(request['phase_probe'], request, job, 1)
    assert not path.exists()
    monkeypatch.setattr(peer, 'PHASE_BYTES', 4096)
    peer.record_training_phase(request['phase_probe'], request, job, 1)
    original = path.read_bytes()
    with pytest.raises(ValueError, match='fresh'): peer.record_training_phase(request['phase_probe'], request, job, 1)
    assert path.read_bytes() == original and not list(path.parent.glob('phase-*'))


def test_hold_stops_at_signed_deadline(authorized, monkeypatch):
    request, job, _ = authorized
    probe(request, 1000)
    ticks = [0.]
    monkeypatch.setattr(peer.time, 'monotonic', lambda: ticks[0])
    monkeypatch.setattr(peer.time, 'time', lambda: 10 + ticks[0])
    monkeypatch.setattr(peer.time, 'sleep', lambda duration: ticks.__setitem__(0, ticks[0] + duration))
    job['deadline_unix_ms'] = 10040
    with pytest.raises(ValueError, match='signed deadline'):
        peer.record_training_phase(request['phase_probe'], request, job, 1)
    assert .039 <= ticks[0] <= .041
