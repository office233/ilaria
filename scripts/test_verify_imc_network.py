"""Deadline regressions for the runner; no models or sockets."""
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import subprocess
import os
import sys
import time
import pytest
import copy
import hashlib
import json

spec = importlib.util.spec_from_file_location('verify_imc_network', Path(__file__).with_name('verify-imc-network.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def test_cumulative_budget_reserves_cleanup_across_phases():
    elapsed = [0.]
    utc = datetime(2026, 10, 2, tzinfo=timezone.utc)
    budget = runner.Budget(utc + timedelta(seconds=120), 20, 5, monotonic=lambda: elapsed[0], utc=lambda: utc)
    assert budget.allowance(90) == 15
    elapsed[0] = 12
    assert budget.allowance(90) == 3
    elapsed[0] = 15
    with pytest.raises(TimeoutError):
        budget.allowance(90)
    assert budget.allowance(90, cleanup=True) == 5


def test_utc_deadline_shortens_monotonic_budget():
    utc = [datetime(2026, 10, 2, tzinfo=timezone.utc)]
    budget = runner.Budget(utc[0] + timedelta(seconds=30), 120, 10, monotonic=lambda: 0., utc=lambda: utc[0])
    assert budget.allowance(90) == 20
    utc[0] += timedelta(seconds=21)
    with pytest.raises(TimeoutError):
        budget.allowance(1)


def test_wait_rechecks_utc_during_running_child():
    utc = [datetime(2026, 10, 2, tzinfo=timezone.utc)]
    budget = runner.Budget(utc[0] + timedelta(seconds=30), 120, 10, monotonic=lambda: 0., utc=lambda: utc[0])
    class Child:
        returncode = None
        waits = 0
        def poll(self): return None
        def wait(self, timeout):
            self.waits += 1
            utc[0] += timedelta(seconds=21)
            raise subprocess.TimeoutExpired('owned fixture', timeout)
    child = Child()
    with pytest.raises(TimeoutError): budget.wait(child, 90)
    assert child.waits == 1


@pytest.mark.parametrize('maximum,reserve', [(121, 10), (120, 120), (float('nan'), 10), (120, -1)])
def test_invalid_total_budget_fails_before_spawn(maximum, reserve):
    with pytest.raises(ValueError):
        runner.Budget(datetime.now(timezone.utc) + timedelta(seconds=120), maximum, reserve)


def test_real_owned_sleeping_child_times_out_and_is_reaped():
    budget = runner.Budget(datetime.now(timezone.utc) + timedelta(seconds=5), 2, 1)
    options = {'creationflags': subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
    child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], **options)
    started = time.monotonic()
    try:
        with pytest.raises(TimeoutError):
            budget.wait(child, .2)
    finally:
        runner.stop_owned(child, budget)
    assert child.poll() is not None
    assert not runner.process_alive(child.pid)
    assert time.monotonic() - started < 2


def progress_fixture(sequence=3):
    progress = {'session': '1'*64, 'genesis': '2'*64, 'parent': '3'*64,
                'lineage': '4'*64, 'sequence': sequence}
    proof = {'rounds': [{'genesis': '2'*64, 'active_hash': '3'*64}],
             'rollback': {'to': '5'*64}}
    durable = {'issuer': {'progress': copy.deepcopy(progress), 'active_hash': '3'*64},
               'proposer': {'progress': copy.deepcopy(progress), 'active_hash': None}}
    return proof, durable


@pytest.mark.parametrize('field', ['session', 'genesis', 'parent', 'lineage', 'sequence'])
def test_progress_peer_mismatch_is_rejected(field):
    proof, durable = progress_fixture()
    durable['proposer']['progress'][field] = 4 if field == 'sequence' else 'f'*64
    with pytest.raises(ValueError):
        runner.validate_durable_progress(proof, durable, 3)


@pytest.mark.parametrize('mutation', ['sequence', 'genesis', 'parent', 'active'])
def test_equal_progress_still_requires_actual_final_round(mutation):
    proof, durable = progress_fixture()
    if mutation == 'active':
        durable['issuer']['active_hash'] = 'f'*64
    else:
        for peer in durable.values():
            peer['progress'][mutation] = 4 if mutation == 'sequence' else 'f'*64
    with pytest.raises(ValueError):
        runner.validate_durable_progress(proof, durable, 3)


def test_rollback_mismatch_is_reported_without_continuity_claim():
    proof, durable = progress_fixture()
    durable['issuer']['active_hash'] = proof['rollback']['to']
    result = runner.validate_durable_progress(proof, durable, 3, rollback=True)
    assert result['continuity_verified'] is False
    assert result['active_matches_progress'] is False
    assert result['unresolved'] == 'rollback progress/active mismatch; rollback-to-resume unproved'


@pytest.mark.parametrize('sequence', [3, 6])
def test_matching_progress_accepts_expected_sequence(sequence):
    proof, durable = progress_fixture(sequence)
    result = runner.validate_durable_progress(proof, durable, sequence)
    assert result['continuity_verified'] is True
    assert result['active_matches_progress'] is True


@pytest.mark.parametrize('role', ['host', 'proposer', 'worker'])
def test_reused_process_identity_rejects_fresh_restart_claim(role):
    first = {'node_pid': 10, 'rounds': [{'remote_os_pid': 11, 'worker_pid': 12}]}
    second = {'node_pid': 20, 'rounds': [{'remote_os_pid': 21, 'worker_pid': 22}]}
    if role == 'host': second['node_pid'] = first['node_pid']
    elif role == 'proposer': second['rounds'][0]['remote_os_pid'] = first['rounds'][0]['remote_os_pid']
    else: second['rounds'][0]['worker_pid'] = first['rounds'][0]['worker_pid']
    with pytest.raises(ValueError):
        runner.validate_fresh_processes(first, second)


def test_distinct_host_proposer_worker_processes_accept_restart_claim():
    first = {'node_pid': 10, 'rounds': [{'remote_os_pid': 11, 'worker_pid': 12}]}
    second = {'node_pid': 20, 'rounds': [{'remote_os_pid': 21, 'worker_pid': 22}]}
    assert runner.validate_fresh_processes(first, second)['fresh_processes_verified'] is True


def rollback_receipt_fixture(certificate_mutation=None):
    """Own random signing key and scalar protocol events; no model or sockets."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
    target = {'session': '1'*64, 'genesis': '2'*64, 'parent': '3'*64,
              'lineage': hashlib.sha256(('2'*64+'3'*64).encode()).hexdigest(), 'sequence': 1}
    before = dict(target, parent='5'*64, lineage=hashlib.sha256((target['lineage']+'5'*64).encode()).hexdigest(), sequence=3)
    lineage_event = {'operation': 'rollback-v1', 'prior_lineage': before['lineage'], 'target_parent': target['parent'],
                     'target_intent_key': target['session']+'round-1', 'sequence': 4}
    after = dict(target, lineage=hashlib.sha256(json.dumps(lineage_event, sort_keys=True, separators=(',', ':')).encode()).hexdigest(), sequence=4)
    certificate = {'protocol_version': 1, 'operation': 'rollback', 'before': before, 'after': after,
                   'target': target, 'target_intent_key': target['session']+'round-1', 'rollback_intent_key': target['session']+'round-4',
                   'nonce': '8'*64, 'consent_epoch': 1, 'lease_fence': 4, 'deadline_unix_ms': 1800000000000}
    if certificate_mutation == 'lineage': after['lineage'] = 'f'*64
    elif certificate_mutation == 'target_key': certificate['target_intent_key'] = target['session']+'round-2'
    elif certificate_mutation == 'nonce': certificate['nonce'] = 'not-a-hash'
    elif certificate_mutation == 'sequence_bool': after['sequence'] = True
    elif certificate_mutation == 'fence_overflow': certificate['lease_fence'] = 1 << 64
    elif certificate_mutation == 'deadline_overflow': certificate['deadline_unix_ms'] = 1 << 63
    elif certificate_mutation == 'field_order': certificate['operation'] = certificate.pop('operation')
    raw_certificate = json.dumps(certificate, separators=(',', ':')).encode()
    notice = {'certificate': certificate, 'signature': private.sign(raw_certificate).hex()}
    raw_notice = json.dumps(notice, separators=(',', ':'))
    certificate_hash = hashlib.sha256(raw_notice.encode()).hexdigest()
    def phase(start, parent, first, second, node, remote, worker):
        rounds = []
        for offset, active in enumerate((first, second, second)):
            rounds.append({'round': 'round-' + str(start+offset), 'accepted': offset < 2,
                           'genesis': '2'*64, 'parent': parent, 'active_hash': active,
                           'before': {'objective': 2.}, 'candidate': {'objective': 1.},
                           'active': {'objective': 1.}, 'remote_os_pid': remote, 'worker_pid': worker})
            parent = active
        return {'rounds': rounds, 'node_pid': node, 'sent_bytes': 100, 'received_bytes': 100,
                'worker_bounds': 'windows_job_object', 'rollback': None}
    initial = phase(1, '2'*64, '3'*64, '5'*64, 10, 11, 12)
    initial['rollback'] = {'from': '5'*64, 'to': '3'*64, 'notice': notice, 'certificate_hash': certificate_hash,
                           'intent': {'id': 'intent-4', 'node_id': 'round-4', 'kind': 'synthetic-model-rollback',
                                      'state': 'COMMITTED', 'fence': 4, 'idempotency_key': target['session']+'round-4',
                                      'request_hash': hashlib.sha256(raw_certificate).hexdigest(),
                                      'external_ref': after['parent'], 'result_hash': certificate_hash}}
    initial['progress'] = after
    resumed = phase(5, '3'*64, '9'*64, 'a'*64, 20, 21, 22)
    resumed_lineage = hashlib.sha256((after['lineage']+'9'*64).encode()).hexdigest()
    resumed_lineage = hashlib.sha256((resumed_lineage+'a'*64).encode()).hexdigest()
    final = dict(after, parent='a'*64, lineage=resumed_lineage, sequence=7)
    resumed['progress'] = final
    resumed['resume_rollback_certificate_hash'] = certificate_hash
    def durable(progress):
        return {'issuer': {'progress': copy.deepcopy(progress), 'active_hash': progress['parent']},
                'proposer': {'progress': copy.deepcopy(progress), 'active_hash': None}}
    metadata = {peer: {'notice_json': raw_notice, 'before': copy.deepcopy(before),
                       'after': copy.deepcopy(after), 'target': copy.deepcopy(target)} for peer in ('issuer', 'proposer')}
    receipt = {'proofs': [{'phase': 'initial', 'proof': initial}, {'phase': 'resumed', 'proof': resumed}],
               'children': [{'label': phase+'-'+role, 'pid': pid} for phase, role, pid in
                            [('initial', 'issuer', 10), ('initial', 'proposer', 11), ('resumed', 'issuer', 20), ('resumed', 'proposer', 21)]],
               'durable_progress': {'initial': durable(after), 'resumed': durable(final)},
               'rollback_metadata': {'initial': metadata}, 'issuer_role_public_key': public,
               'rollback_resume_requested': True, 'rollback_then_resume_proved': True,
               'next_sequence_continuation': True,
               'state_paths': {phase: {'issuer': '/own/issuer', 'proposer': '/own/proposer'} for phase in ('initial', 'resumed')},
               'restart_replay': {'returncode': 1, 'denied_before_worker_allocation': True}}
    return receipt


def test_signed_journaled_rollback_then_fresh_restart_accepts():
    result = runner.validate_recorded_receipt(rollback_receipt_fixture())
    assert result['initial']['sequence'] == 4
    assert result['initial']['issuer_role_signature_verified'] is True
    assert result['resumed']['sequence'] == 7
    assert result['rollback_then_resume_verified'] is True


@pytest.mark.parametrize('fence', [5, True, 0, 1 << 64])
def test_journal_fence_must_match_signed_uint64_lease(fence):
    receipt = rollback_receipt_fixture()
    receipt['proofs'][0]['proof']['rollback']['intent']['fence'] = fence
    with pytest.raises(ValueError): runner.validate_recorded_receipt(receipt)


@pytest.mark.parametrize('mutation', ['lineage', 'target_key', 'nonce', 'sequence_bool', 'fence_overflow', 'deadline_overflow', 'field_order'])
def test_authentic_signature_does_not_authorize_invalid_rollback_events(mutation):
    with pytest.raises(ValueError):
        runner.validate_recorded_receipt(rollback_receipt_fixture(mutation))


def test_journaled_rollback_without_restart_does_not_claim_continuation():
    receipt = rollback_receipt_fixture()
    receipt['proofs'] = receipt['proofs'][:1]
    receipt['rollback_resume_requested'] = False
    receipt['rollback_then_resume_proved'] = False
    receipt['next_sequence_continuation'] = False
    result = runner.validate_recorded_receipt(receipt)
    assert result['initial']['sequence'] == 4
    assert 'rollback_then_resume_verified' not in result


def test_unrequested_rollback_continuation_claim_is_rejected():
    receipt = rollback_receipt_fixture()
    initial, resumed = (item['proof'] for item in receipt['proofs'])
    before = initial['rollback']['notice']['certificate']['before']
    initial['rollback'] = None
    initial['progress'] = before
    for peer in receipt['durable_progress']['initial'].values(): peer['progress'] = copy.deepcopy(before)
    receipt['durable_progress']['initial']['issuer']['active_hash'] = before['parent']
    for offset, round_ in enumerate(resumed['rounds']): round_['round'] = 'round-' + str(4+offset)
    resumed['rounds'][0]['parent'] = before['parent']
    resumed['progress']['sequence'] = 6
    for peer in receipt['durable_progress']['resumed'].values(): peer['progress']['sequence'] = 6
    receipt['rollback_resume_requested'] = False
    with pytest.raises(ValueError): runner.validate_recorded_receipt(receipt)


@pytest.mark.parametrize('mutation', ['signature', 'issuer_role', 'notice_hash', 'peer_notice', 'before_history',
                                      'target_history', 'after_history', 'journal_state', 'journal_request',
                                      'journal_result', 'journal_key', 'stale_active', 'stale_progress',
                                      'resumed_parent', 'resumed_sequence', 'resume_certificate',
                                      'different_state', 'replay_allocated', 'fresh_pid'])
def test_rollback_restart_rejects_forged_or_stale_recorded_events(mutation):
    receipt = rollback_receipt_fixture()
    first = receipt['proofs'][0]['proof']
    second = receipt['proofs'][1]['proof']
    metadata = receipt['rollback_metadata']['initial']['proposer']
    if mutation == 'signature': first['rollback']['notice']['signature'] = '00'*64
    elif mutation == 'issuer_role': receipt['issuer_role_public_key'] = '00'*32
    elif mutation == 'notice_hash': first['rollback']['certificate_hash'] = 'f'*64
    elif mutation == 'peer_notice': metadata['notice_json'] += '\n'
    elif mutation == 'before_history': metadata['before']['parent'] = 'f'*64
    elif mutation == 'target_history': metadata['target']['parent'] = 'f'*64
    elif mutation == 'after_history': metadata['after']['sequence'] = 3
    elif mutation == 'journal_state': first['rollback']['intent']['state'] = 'STARTED'
    elif mutation == 'journal_request': first['rollback']['intent']['request_hash'] = 'f'*64
    elif mutation == 'journal_result': first['rollback']['intent']['result_hash'] = 'f'*64
    elif mutation == 'journal_key': first['rollback']['intent']['idempotency_key'] = 'different-operation'
    elif mutation == 'stale_active': receipt['durable_progress']['initial']['issuer']['active_hash'] = '5'*64
    elif mutation == 'stale_progress':
        for peer in receipt['durable_progress']['initial'].values(): peer['progress']['parent'] = '5'*64
    elif mutation == 'resumed_parent': second['rounds'][0]['parent'] = '5'*64
    elif mutation == 'resumed_sequence': second['rounds'][0]['round'] = 'round-4'
    elif mutation == 'resume_certificate': second['resume_rollback_certificate_hash'] = 'f'*64
    elif mutation == 'different_state': receipt['state_paths']['resumed']['issuer'] = '/different/issuer'
    elif mutation == 'replay_allocated': receipt['restart_replay']['denied_before_worker_allocation'] = False
    else: second['rounds'][0]['worker_pid'] = first['rounds'][0]['worker_pid']
    with pytest.raises(ValueError): runner.validate_recorded_receipt(receipt)


@pytest.mark.skipif(os.name != 'nt', reason='two-OS runner helpers map Windows drive-letter paths; the runner orchestrates from a Windows host')
def test_two_os_helpers_map_drive_paths_and_cannot_match_their_own_shell():
    assert runner.wsl_path('E:/nexus-training/x y/z') == '/mnt/e/nexus-training/x y/z'
    assert runner.wsl_path('relative/dir').startswith('/mnt/')  # relative paths resolve to an absolute drive path first
    pattern = runner.guarded_pattern('--network-config /mnt/e/run/cfg.json')
    assert pattern == '[-]-network-config /mnt/e/run/cfg.json'
    import re
    assert re.search(pattern, 'network-node --local-probe --network-config /mnt/e/run/cfg.json')
    assert not re.search(pattern, "sh -c pgrep -f -- '" + pattern + "'")

def _fault_receipt(**fault_overrides):
    fault = {'kind': 'proposer-node-loss', 'fail_closed': True, 'issuer_exit_code': 1, 'accepted_rounds_after_loss': 0,
             'issuer_pending_exists': False, 'survivors': [], 'reservations_at_kill': 2,
             'issuer_progress': json.dumps({'sequence': 0, 'parent': 'g', 'genesis': 'g'})}
    fault.update(fault_overrides)
    return {'classification': 'SYNTHETIC+FAULT_PROPOSER_LOSS', 'proofs': [{'phase': 'recovery', 'proof': {}}], 'faults': [fault],
            'children': [{'label': 'faulted-issuer', 'returncode': 1}, {'label': 'faulted-proposer', 'returncode': 9}]}


@pytest.mark.parametrize('override,message', [
    ({'fail_closed': False}, 'did not fail closed'),
    ({'accepted_rounds_after_loss': 1}, 'did not fail closed'),
    ({'issuer_pending_exists': True}, 'did not fail closed'),
    ({'reservations_at_kill': 0}, 'did not fail closed'),
    ({'survivors': ['613']}, 'did not fail closed'),
    ({'issuer_progress': json.dumps({'sequence': 1, 'parent': 'c', 'genesis': 'g'})}, 'advanced after node loss'),
])
def test_fault_receipt_rejects_unsafe_node_loss(override, message):
    with pytest.raises(ValueError, match=message):
        runner.validate_recorded_receipt(_fault_receipt(**override))


def test_fault_receipt_requires_abnormal_faulted_exits_and_explicit_mode():
    receipt = _fault_receipt()
    receipt['children'][0]['returncode'] = 0
    with pytest.raises(ValueError, match='did not terminate abnormally'):
        runner.validate_recorded_receipt(receipt)
    plain = _fault_receipt()
    plain['classification'] = 'SYNTHETIC'
    with pytest.raises(ValueError, match='unknown recorded proof phase'):
        runner.validate_recorded_receipt(plain)

