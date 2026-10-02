#!/usr/bin/env python3
"""Opt-in synthetic IMC TCP proof with one cumulative deadline and own cleanup."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]


class Budget:
    def __init__(self, deadline, maximum=120, reserve=10, monotonic=time.monotonic,
                 utc=lambda: datetime.now(timezone.utc)):
        if not isinstance(deadline, datetime) or deadline.utcoffset() is None:
            raise ValueError('absolute deadline requires an explicit timezone')
        if (not math.isfinite(maximum) or not 0 < maximum <= 120 or
                not math.isfinite(reserve) or not 0 < reserve < maximum):
            raise ValueError('require 0 < cleanup reserve < wall budget <= 120 seconds')
        self.deadline, self.maximum, self.reserve = deadline, maximum, reserve
        self.monotonic, self.utc, self.started = monotonic, utc, monotonic()

    def remaining(self, cleanup=False):
        left = min(self.maximum - (self.monotonic() - self.started),
                   (self.deadline - self.utc()).total_seconds())
        return left if cleanup else left - self.reserve

    def allowance(self, ceiling, cleanup=False):
        left = min(ceiling, self.remaining(cleanup))
        if left <= 0:
            raise TimeoutError('cumulative UTC/monotonic budget expired; cleanup reserved')
        return left

    def wait(self, process, ceiling, check=lambda: None):
        end = self.monotonic() + self.allowance(ceiling)
        while True:
            check()
            if process.poll() is not None:
                return process.returncode
            delay = self.allowance(min(.1, end - self.monotonic()))
            try:
                return process.wait(timeout=delay)
            except subprocess.TimeoutExpired:
                pass


class BoundedOutput:
    def __init__(self, stream, path, limit=65536):
        self.data = bytearray()
        self.lock, self.ready = threading.Lock(), threading.Event()
        self.error = None
        def drain():
            try:
                with open(path, 'xb') as log:
                    while True:
                        chunk = stream.read1(4096)
                        if not chunk:
                            break
                        with self.lock:
                            if len(self.data) + len(chunk) > limit:
                                raise ValueError('output byte budget exceeded')
                            self.data.extend(chunk)
                            log.write(chunk)
                            if b'"ready":true' in self.data:
                                self.ready.set()
            except Exception as exc:
                self.error = str(exc)
        self.thread = threading.Thread(target=drain, daemon=True)
        self.thread.start()

    def text(self):
        with self.lock:
            return self.data.decode('utf8', errors='replace')


def key():
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
    return private.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                 serialization.NoEncryption()).hex() + public, public


def endpoint():
    with socket.socket() as stream:
        stream.bind(('127.0.0.1', 0))
        return '127.0.0.1:' + str(stream.getsockname()[1])


def wsl_path(path):
    """Windows drive path -> WSL /mnt path (two-OS proposer mode only)."""
    text = str(Path(path).resolve()).replace('\\', '/')
    if len(text) < 3 or text[1] != ':':
        raise ValueError('WSL proposer mode requires drive-letter paths: ' + text)
    return '/mnt/' + text[0].lower() + text[2:]


def windows_listening(port):
    """True when Windows has a LISTENING socket on 127.0.0.1:port (WSL localhost forwarding)."""
    out = subprocess.run(['netstat', '-ano', '-p', 'TCP'], capture_output=True, text=True, timeout=10).stdout
    return any(line.split()[1:2] == ['127.0.0.1:' + str(port)] and 'LISTENING' in line
               for line in out.splitlines() if line.strip())


def wsl_query(distro, script, timeout=20):
    result = subprocess.run(['wsl', '-d', distro, '--exec', 'sh', '-c', script], capture_output=True, text=True, timeout=timeout)
    return result.stdout.strip()


def wsl_root(distro, script, timeout=30):
    """Operator step inside the WSL VM (cgroup v2 delegation only); fails closed."""
    result = subprocess.run(['wsl', '-d', distro, '-u', 'root', '--exec', 'sh', '-c', script], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('WSL operator step failed: ' + (result.stderr or result.stdout).strip()[:300])
    return result.stdout.strip()


def guarded_pattern(text):
    """pgrep/pkill pattern that cannot match the sh -c process carrying it."""
    return '[' + text[0] + ']' + text[1:]


def source_pins():
    paths = [Path(__file__).resolve(), ROOT / 'ilaria/runtime/isxprobe/peer.py',
             ROOT / 'ilaria/forge/imc_model.py', ROOT / 'ilaria/forge/collective_sleep.py',
             ROOT / 'ilaria/forge/atomic_io.py',
             ROOT / 'ilaria/specs/myriad.swyp', ROOT / 'ilaria/specs/myriad.manifest.json',
             ROOT / 'swypik-os/go.mod', ROOT / 'swypik-os/go.sum']
    paths.extend((ROOT / 'swypik-os').rglob('*.go'))
    return {str(path.relative_to(ROOT)).replace('\\', '/'): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(set(paths))}


def process_alive(pid):
    if os.name != 'nt':
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        if ctypes.get_last_error() == 87:
            return False
        raise OSError(ctypes.get_last_error(), 'cannot verify owned process exit')
    try:
        code = wintypes.DWORD()
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        return code.value == 259
    finally:
        kernel.CloseHandle(handle)


def stop_owned(process, budget):
    """Only our live child tree; existing OS Job Objects contain model workers."""
    if os.name == 'nt' and process.poll() is None:
        helper = None
        try:
            helper = subprocess.Popen(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                      creationflags=subprocess.CREATE_NO_WINDOW)
            helper.wait(timeout=budget.allowance(2, cleanup=True))
        except (OSError, subprocess.TimeoutExpired, TimeoutError):
            if helper is not None and helper.poll() is None:
                helper.kill()
                try:
                    helper.wait(timeout=budget.allowance(.2, cleanup=True))
                except (subprocess.TimeoutExpired, TimeoutError):
                    pass
            if process.poll() is None:
                process.kill()
    elif os.name != 'nt':
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if process.poll() is None:
        try:
            process.wait(timeout=budget.allowance(2, cleanup=True))
        except (subprocess.TimeoutExpired, TimeoutError):
            pass


def validate_rounds(proof, first_sequence, rollback):
    rounds = proof['rounds']
    if len(rounds) != 3 or [r['accepted'] for r in rounds] != [True, True, False]:
        raise ValueError('required two accepted rounds plus rejected candidate not achieved')
    if [r['round'] for r in rounds] != ['round-' + str(first_sequence + i) for i in range(3)]:
        raise ValueError('actual round sequence did not continue')
    if (rounds[1]['parent'] != rounds[0]['active_hash'] or
            rounds[2]['parent'] != rounds[1]['active_hash'] or
            rounds[2]['active_hash'] != rounds[1]['active_hash']):
        raise ValueError('continuous parent/rejection hash invariant')
    for round_ in rounds[:2]:
        if (round_['parent'] == round_['active_hash'] or
                not round_['candidate']['objective'] < round_['before']['objective'] or
                round_['active']['objective'] != round_['candidate']['objective']):
            raise ValueError('accepted update lacks actual objective/hash improvement')
    if (proof['node_pid'] == rounds[0]['remote_os_pid'] or
            not proof['sent_bytes'] or not proof['received_bytes'] or
            proof['worker_bounds'] not in ('windows_job_object', 'linux_cgroup_v2')):
        raise ValueError('distinct OS/socket/hard worker containment evidence missing')
    if rollback and (proof['rollback']['from'] != rounds[1]['active_hash'] or
                     proof['rollback']['to'] != rounds[0]['active_hash']):
        raise ValueError('controlled rollback parent invariant')
    return rounds


def validate_durable_progress(proof, durable, expected_sequence, rollback=False):
    issuer, proposer = durable['issuer']['progress'], durable['proposer']['progress']
    fields = {'session', 'genesis', 'parent', 'lineage', 'sequence'}
    if not isinstance(issuer, dict) or not isinstance(proposer, dict) or set(issuer) != fields or set(proposer) != fields:
        raise ValueError('malformed durable progress')
    if issuer != proposer:
        raise ValueError('issuer/proposer durable progress mismatch')
    if type(issuer['sequence']) is not int or issuer['sequence'] != expected_sequence:
        raise ValueError('durable progress final sequence mismatch')
    for field in fields - {'sequence'}:
        value = issuer[field]
        if not isinstance(value, str) or len(value) != 64 or any(ch not in '0123456789abcdef' for ch in value):
            raise ValueError('invalid durable progress identity: ' + field)
    if any(round_['genesis'] != issuer['genesis'] for round_ in proof['rounds']):
        raise ValueError('durable progress genesis differs from actual rounds')
    if issuer['parent'] != proof['rounds'][-1]['active_hash']:
        raise ValueError('durable progress parent differs from final round')
    if 'progress' in proof and proof['progress'] != issuer:
        raise ValueError('proof progress differs from durable peer progress')
    active = durable['issuer']['active_hash']
    matches = active == issuer['parent']
    if not rollback and not matches:
        raise ValueError('active pointer differs from durable progress/final round')
    if rollback and active != proof['rollback']['to']:
        raise ValueError('rollback active pointer differs from measured rollback target')
    result = {'peer_progress_match': True, 'sequence': expected_sequence,
              'active_matches_progress': matches, 'continuity_verified': not rollback}
    if rollback:
        result['unresolved'] = ('rollback progress/active mismatch; rollback-to-resume unproved'
                                if not matches else 'rollback-to-resume unproved')
    return result


def validate_fresh_processes(first, second):
    def identities(proof):
        host = {proof['node_pid']}
        proposers = {round_['remote_os_pid'] for round_ in proof['rounds']}
        workers = {round_['worker_pid'] for round_ in proof['rounds']}
        pids = host | proposers | workers
        if (any(type(pid) is not int or pid <= 0 for pid in pids) or
                host & proposers or host & workers or proposers & workers):
            raise ValueError('invalid/distinct host, proposer or worker PID evidence')
        return pids
    initial, resumed = identities(first), identities(second)
    if initial & resumed:
        raise ValueError('resumed host/proposer/worker PID reused from initial invocation')
    return {'fresh_processes_verified': True, 'initial_pids': sorted(initial), 'resumed_pids': sorted(resumed)}


def validate_journaled_rollback(proof, durable, metadata, issuer_public, final_round_sequence):
    """Verify recorded public certificates/history; never supplies OS authority."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    from cryptography.exceptions import InvalidSignature

    rollback = proof['rollback']
    notice = rollback['notice']
    if not isinstance(notice, dict) or list(notice) != ['certificate', 'signature']:
        raise ValueError('malformed rollback notice')
    certificate = notice['certificate']
    expected_fields = ['protocol_version', 'operation', 'before', 'after', 'target',
                       'target_intent_key', 'rollback_intent_key', 'nonce',
                       'consent_epoch', 'lease_fence', 'deadline_unix_ms']
    if (not isinstance(certificate, dict) or list(certificate) != expected_fields or
            certificate['protocol_version'] != 1 or certificate['operation'] != 'rollback'):
        raise ValueError('malformed rollback certificate')
    for field in ('protocol_version', 'consent_epoch', 'lease_fence', 'deadline_unix_ms'):
        ceiling = (1 << 63) - 1 if field == 'deadline_unix_ms' else (1 << 64) - 1
        if type(certificate[field]) is not int or not 0 < certificate[field] <= ceiling:
            raise ValueError('invalid rollback certificate bound: ' + field)
    if certificate['consent_epoch'] != 1:
        raise ValueError('rollback consent epoch differs from configured synthetic consent')
    raw_certificate = json.dumps(certificate, separators=(',', ':'), ensure_ascii=True).encode()
    raw_notice = json.dumps(notice, separators=(',', ':'), ensure_ascii=True)
    certificate_hash = hashlib.sha256(raw_notice.encode()).hexdigest()
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(issuer_public)).verify(
            bytes.fromhex(notice['signature']), raw_certificate)
    except (InvalidSignature, ValueError, TypeError) as exc:
        raise ValueError('rollback issuer-role signature invalid') from exc
    if certificate_hash != rollback['certificate_hash']:
        raise ValueError('rollback certificate hash differs from actual proof')
    before, after, target = (certificate[field] for field in ('before', 'after', 'target'))
    fields = {'session', 'genesis', 'parent', 'lineage', 'sequence'}
    for progress in (before, after, target):
        if (not isinstance(progress, dict) or list(progress) != ['session', 'genesis', 'parent', 'lineage', 'sequence'] or type(progress['sequence']) is not int or
                not 0 <= progress['sequence'] < 1 << 64):
            raise ValueError('malformed rollback progress event')
        for field in fields - {'sequence'}:
            value = progress[field]
            if not isinstance(value, str) or len(value) != 64 or any(ch not in '0123456789abcdef' for ch in value):
                raise ValueError('invalid rollback progress identity: ' + field)
    if (before['sequence'] != final_round_sequence or after['sequence'] != final_round_sequence + 1 or
            target['sequence'] != final_round_sequence - 2 or
            any(progress[field] != before[field] for progress in (after, target) for field in ('session', 'genesis'))):
        raise ValueError('rollback event sequence/session/genesis invariant')
    if (before['parent'] != proof['rounds'][-1]['active_hash'] or
            after['parent'] != rollback['to'] or target['parent'] != after['parent'] or
            target['parent'] != proof['rounds'][0]['active_hash'] or
            rollback['from'] != before['parent']):
        raise ValueError('rollback event parent is not the measured committed ancestor')
    target_key = before['session'] + 'round-' + str(target['sequence'])
    rollback_key = before['session'] + 'round-' + str(after['sequence'])
    lineage_event = {'operation': 'rollback-v1', 'prior_lineage': before['lineage'],
                     'target_parent': target['parent'], 'target_intent_key': target_key, 'sequence': after['sequence']}
    expected_lineage = hashlib.sha256(json.dumps(lineage_event, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    if (certificate['target_intent_key'] != target_key or certificate['rollback_intent_key'] != rollback_key or
            after['lineage'] != expected_lineage or
            target['lineage'] != hashlib.sha256((target['genesis'] + target['parent']).encode()).hexdigest() or
            before['lineage'] != hashlib.sha256((target['lineage'] + before['parent']).encode()).hexdigest() or
            any(round_['genesis'] != before['genesis'] for round_ in proof['rounds'])):
        raise ValueError('rollback event lineage/intent binding mismatch')
    nonce = certificate['nonce']
    if not isinstance(nonce, str) or len(nonce) != 64 or any(ch not in '0123456789abcdef' for ch in nonce):
        raise ValueError('rollback nonce is not a typed SHA256 identity')
    for peer in ('issuer', 'proposer'):
        recorded = metadata[peer]
        if (recorded['notice_json'] != raw_notice or recorded['before'] != before or
                recorded['after'] != after or recorded['target'] != target):
            raise ValueError('peer durable rollback certificate/history mismatch')
        if durable[peer]['progress'] != after:
            raise ValueError('peer durable rollback progress differs from signed event')
    if durable['issuer']['active_hash'] != after['parent'] or proof['progress'] != after:
        raise ValueError('rollback active/proof progress differs from signed event')
    intent = rollback['intent']
    if (type(intent.get('fence')) is not int or not 0 < intent['fence'] < 1 << 64 or
            intent['fence'] != certificate['lease_fence'] or
            intent['kind'] != 'synthetic-model-rollback' or intent['state'] != 'COMMITTED' or
            intent['idempotency_key'] != certificate['rollback_intent_key'] or
            intent['request_hash'] != hashlib.sha256(raw_certificate).hexdigest() or
            intent['result_hash'] != certificate_hash or not intent['id'] or
            intent['node_id'] != 'round-' + str(after['sequence']) or intent['external_ref'] != after['parent']):
        raise ValueError('rollback journal result is not bound to the signed operation')
    return {'certificate_hash': certificate_hash, 'issuer_role_signature_verified': True,
            'committed_journal_verified': True, 'peer_progress_match': True,
            'sequence': after['sequence'], 'active_matches_progress': True,
            'continuity_verified': True}


def validate_recorded_receipt(receipt):
    """Pure checks for a historical receipt; never mutates state or launches work."""
    proofs = {item['phase']: item['proof'] for item in receipt['proofs']}
    fault_mode = 'FAULT_PROPOSER_LOSS' in receipt.get('classification', '')
    allowed = {'recovery'} if fault_mode else {'initial', 'resumed', 'rollback'}
    if len(proofs) != len(receipt['proofs']) or set(proofs) - allowed:
        raise ValueError('duplicate/unknown recorded proof phase')
    children = {item['label']: item for item in receipt['children']}
    if fault_mode:
        faults = receipt.get('faults') or []
        if set(proofs) != {'recovery'} or len(faults) != 1:
            raise ValueError('fault probe requires exactly one injected loss and one recovery proof')
        fault = faults[0]
        if not (fault.get('kind') == 'proposer-node-loss' and fault.get('fail_closed') is True and
                fault.get('issuer_exit_code') not in (0, None) and fault.get('accepted_rounds_after_loss') == 0 and
                fault.get('issuer_pending_exists') is False and not fault.get('survivors') and fault.get('reservations_at_kill', 0) >= 1):
            raise ValueError('injected node loss did not fail closed')
        progress = json.loads(fault['issuer_progress']) if fault.get('issuer_progress') else None
        if progress is not None and (progress.get('sequence') != 0 or progress.get('parent') != progress.get('genesis')):
            raise ValueError('issuer advanced after node loss')
        if any(children.get('faulted-' + name, {}).get('returncode') in (0, None) for name in ('issuer', 'proposer')):
            raise ValueError('faulted nodes did not terminate abnormally')
    elif 'initial' not in proofs:
        raise ValueError('missing initial recorded proof')
    results = {}
    rollback_resume = receipt.get('rollback_resume_requested', False)
    if receipt.get('rollback_then_resume_proved') and not rollback_resume:
        raise ValueError('rollback continuation claim lacks explicit proof mode')
    if rollback_resume and set(proofs) != {'initial', 'resumed'}:
        raise ValueError('rollback continuation requires same-session initial and resumed phases')
    for phase, proof in proofs.items():
        sequence = (7 if rollback_resume else 6) if phase == 'resumed' else 3
        rollback = bool(proof.get('rollback'))
        validate_rounds(proof, sequence - 2, rollback)
        if (proof['node_pid'] != children[phase + '-issuer']['pid'] or
                any(round_['remote_os_pid'] != children[phase + '-proposer'].get('linux_pid', children[phase + '-proposer']['pid'])
                    for round_ in proof['rounds'])):
            raise ValueError('recorded host/proposer PID differs from spawned child')
        if rollback and proof['rollback'].get('notice'):
            results[phase] = validate_journaled_rollback(proof, receipt['durable_progress'][phase],
                                                       receipt['rollback_metadata'][phase], receipt['issuer_role_public_key'], sequence)
        else:
            if rollback_resume and phase == 'initial':
                raise ValueError('rollback continuation lacks signed journal-governed event')
            results[phase] = validate_durable_progress(proof, receipt['durable_progress'][phase], sequence, rollback)
    if receipt.get('next_sequence_continuation') and 'resumed' not in proofs:
        raise ValueError('claimed continuation lacks resumed proof')
    if 'resumed' in proofs:
        initial = receipt['durable_progress']['initial']['issuer']['progress']
        resumed = receipt['durable_progress']['resumed']['issuer']['progress']
        if (any(initial[field] != resumed[field] for field in ('session', 'genesis')) or
                proofs['resumed']['rounds'][0]['parent'] != initial['parent']):
            raise ValueError('resumed progress did not retain session/genesis/committed parent')
        results['fresh_processes'] = validate_fresh_processes(proofs['initial'], proofs['resumed'])
    if rollback_resume:
        if (not proofs['initial'].get('rollback') or proofs['resumed'].get('rollback') or
                proofs['resumed'].get('resume_rollback_certificate_hash') != results['initial']['certificate_hash'] or
                initial['sequence'] != 4 or resumed['sequence'] != 7 or
                not receipt['restart_replay']['denied_before_worker_allocation'] or receipt['restart_replay']['returncode'] == 0):
            raise ValueError('rollback restart/replay/certificate continuation invariant')
        if (receipt['state_paths']['initial'] != receipt['state_paths']['resumed'] or
                set(receipt['state_paths']['initial']) != {'issuer', 'proposer'} or
                len(set(receipt['state_paths']['initial'].values())) != 2):
            raise ValueError('rollback restart must reuse both exact durable state directories')
        lineage = initial['lineage']
        for round_ in proofs['resumed']['rounds'][:2]:
            lineage = hashlib.sha256((lineage + round_['active_hash']).encode()).hexdigest()
        if resumed['lineage'] != lineage:
            raise ValueError('resumed signed lineage did not extend rollback event')
        results['rollback_then_resume_verified'] = True
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--python', required=True)
    parser.add_argument('--public-library-root', default='')
    parser.add_argument('--temp-root', required=True, help='explicit durable evidence parent')
    parser.add_argument('--absolute-deadline', required=True)
    parser.add_argument('--max-wall-seconds', type=float, default=120)
    parser.add_argument('--cleanup-reserve-seconds', type=float, default=10)
    continuation = parser.add_mutually_exclusive_group()
    continuation.add_argument('--resume-continuation', action='store_true')
    continuation.add_argument('--rollback-resume-continuation', action='store_true',
                              help='journal-governed rollback followed by same-session fresh restart')
    parser.add_argument('--enable-synthetic-training', action='store_true')
    parser.add_argument('--proposer-wsl-distro', default='', help='run the proposer node and IMC worker inside this WSL2 distribution '
                        '(two OS instances on one physical host)')
    parser.add_argument('--proposer-wsl-python', default='', help='absolute Linux Python path for the proposer worker')
    parser.add_argument('--fault-proposer-loss', action='store_true', help='inject sudden loss of the whole Linux proposer device mid-round, then prove recovery')
    parser.add_argument('--proposer-linux-delegated-root', default='', help='cgroup v2 root to delegate (default /sys/fs/cgroup/nexus-p2p-<run>)')
    args = parser.parse_args(argv)
    if not args.enable_synthetic_training:
        parser.error('explicit --enable-synthetic-training is required')
    deadline = datetime.fromisoformat(args.absolute_deadline.replace('Z', '+00:00'))
    budget = Budget(deadline, args.max_wall_seconds, args.cleanup_reserve_seconds)
    budget.allowance(120)
    out = Path(tempfile.mkdtemp(prefix='bounded-tcp-', dir=args.temp_root))
    receipt = {'format': 'imc-bounded-tcp-v1', 'status': 'INCOMPLETE',
               'absolute_deadline': args.absolute_deadline, 'max_wall_seconds': budget.maximum,
               'cleanup_reserve_seconds': budget.reserve, 'proofs': [], 'children': [],
               'classification': 'SYNTHETIC_IMC_LOOPBACK_ONLY', 'next_sequence_continuation': False,
               'rollback_then_resume_proved': False,
               'rollback_resume_requested': args.rollback_resume_continuation}
    pins = source_pins()
    wsl_mode = bool(args.proposer_wsl_distro)
    linux_pids = set()
    cgroup_created, cgroot, wsl_uid, wsl_gid, wsl_home = False, '', '', '', ''
    if wsl_mode:
        if not args.proposer_wsl_python.startswith('/'):
            parser.error('--proposer-wsl-python must be an absolute Linux path')
        receipt['classification'] = 'SYNTHETIC_IMC_TWO_OS_SAME_HOST_WSL_LOCALHOST_FORWARD'
        receipt['topology'] = {'issuer': {'os': 'windows', 'role': 'dials'},
                               'proposer': {'os': 'linux-wsl2', 'distro': args.proposer_wsl_distro, 'role': 'listens/accepts'},
                               'path': 'Windows 127.0.0.1 -> WSL2 localhost forwarding -> Linux listener'}
        receipt['proposer_kernel'] = wsl_query(args.proposer_wsl_distro, 'uname -sr')
    (out / 'source-pins.json').write_text(json.dumps(pins, indent=2) + '\n')
    children, observed_pids = [], set()
    keepalive = None
    env = dict(os.environ, GOWORK='off', GOTOOLCHAIN='local', GOPROXY='off', GOSUMDB='off',
               GOMAXPROCS='2', GOTMPDIR=str(out), SWYPIK_SWARM_TRAINING_ENABLED='true')
    binary = out / ('network-node.exe' if os.name == 'nt' else 'network-node')

    def start(label, command, cwd, secret=None, extra_env=None):
        budget.allowance(120)
        options = {'creationflags': subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
        process = subprocess.Popen(command, stdin=subprocess.PIPE if secret is not None else subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=cwd, env=dict(env, **extra_env) if extra_env else env, **options)
        child = {'label': label, 'process': process, 'log': BoundedOutput(process.stdout, out / (label + '.log'))}
        children.append(child)
        observed_pids.add(process.pid)
        if secret is not None:
            process.stdin.write((json.dumps(secret) + '\n').encode())
            process.stdin.close()
        return child

    def errors():
        for child in children:
            if child['log'].error:
                raise ValueError(child['label'] + ': ' + child['log'].error)

    def finish(child, ceiling=90):
        code = budget.wait(child['process'], ceiling, errors)
        child['log'].thread.join(timeout=budget.allowance(2))
        if child['log'].thread.is_alive():
            raise TimeoutError('output drain exceeded cumulative deadline')
        errors()
        return code

    try:
        build = start('build', ['go', 'build', '-o', str(binary), './cmd/imc-peer-probe'], ROOT / 'swypik-os')
        if finish(build, 60):
            raise RuntimeError('build failed: ' + build['log'].text()[:8000])
        linux_binary = out / 'network-node-linux'
        if wsl_mode:
            build_linux = start('build-linux', ['go', 'build', '-o', str(linux_binary), './cmd/imc-peer-probe'], ROOT / 'swypik-os',
                                extra_env={'GOOS': 'linux', 'GOARCH': 'amd64', 'CGO_ENABLED': '0'})
            if finish(build_linux, 90):
                raise RuntimeError('linux build failed: ' + build_linux['log'].text()[:8000])
            ids = wsl_query(args.proposer_wsl_distro, 'id -u; id -g; printf %s "$HOME"').split()
            if len(ids) != 3 or not ids[0].isdigit() or not ids[1].isdigit() or ids[0] == '0':
                raise RuntimeError('WSL default user must be an unprivileged account')
            wsl_uid, wsl_gid, wsl_home = ids
            cgroot = args.proposer_linux_delegated_root or '/sys/fs/cgroup/nexus-p2p-' + out.name
            leaf = cgroot[len('/sys/fs/cgroup/'):] if cgroot.startswith('/sys/fs/cgroup/') else ''
            if not leaf or any(not (ch.isalnum() or ch in '._-') for ch in leaf):
                raise ValueError('delegated cgroup root must be a direct child of /sys/fs/cgroup')
            controllers = wsl_root(args.proposer_wsl_distro,
                                   'set -e; R=' + shlex.quote(cgroot) + '; for c in cpu memory pids; do grep -qw $c /sys/fs/cgroup/cgroup.subtree_control; done; '
                                   'mkdir "$R" "$R/node"; chown ' + wsl_uid + ':' + wsl_gid + ' "$R" "$R/cgroup.procs" "$R/cgroup.subtree_control" '
                                   '"$R/cgroup.threads" "$R/node" "$R/node/cgroup.procs"; cat "$R/cgroup.controllers"')
            cgroup_created = True
            if not {'cpu', 'memory', 'pids'} <= set(controllers.split()):
                raise RuntimeError('delegated cgroup lacks cpu/memory/pids controllers: ' + controllers)
            receipt['linux_cgroup'] = {'delegated_root': cgroot, 'node_cgroup_policy': 'fresh leaf <root>/node-<phase> per node launch: after cgroup.kill, '
                                       'clone3(CLONE_INTO_CGROUP) from a killed cgroup into a new cgroup is SIGKILLed by the kernel (kill_seq mismatch)', 'controllers': controllers.split(),
                                       'owner_uid': int(wsl_uid), 'operator_step': 'root mkdir+chown only; root subtree_control unchanged'}
            if args.fault_proposer_loss:
                keepalive = subprocess.Popen(['wsl', '-d', args.proposer_wsl_distro, '--exec', 'sleep', str(int(args.max_wall_seconds) + 60)],
                                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                observed_pids.add(keepalive.pid)
                receipt['wsl_keepalive'] = {'pid': keepalive.pid, 'reason': 'testbed only: keeps the WSL instance (the Linux device OS) running when the node session dies; '
                                            'without it WSL terminates the instance and SIGTERMs the recovery node; not part of the P2P protocol'}
        issuer_private, issuer_public = key()
        proposer_private, proposer_public = key()
        role_private, role_public = key()
        evaluator_private, evaluator_public = key()
        receipt['issuer_role_public_key'] = role_public
        secrets = {'issuer': {'transport_private': issuer_private, 'role_private': role_private, 'evaluator_private': evaluator_private},
                   'proposer': {'transport_private': proposer_private, 'role_private': proposer_private, 'evaluator_private': ''}}

        def cgroup_tree():
            return wsl_query(args.proposer_wsl_distro, 'for c in $(find ' + shlex.quote(cgroot) + ' -type d); do echo "$c procs=$(wc -l < $c/cgroup.procs) $(grep populated $c/cgroup.events)"; done').splitlines()

        def fault_probe(label, nodes, state_prefix):
            proposer, issuer = nodes['proposer'], nodes['issuer']
            node_pid = proposer.get('linux_pid')
            if not node_pid:
                raise RuntimeError('proposer-loss probe requires the WSL proposer mode')
            proposer_state = out / (state_prefix + 'proposer')
            worker, reserved, until = None, [], budget.monotonic() + budget.allowance(40)
            while not reserved:
                errors()
                if issuer['process'].poll() is not None or proposer['process'].poll() is not None:
                    raise RuntimeError('round ended before a job reservation was observed; node loss not injected')
                reserved = sorted(path.name for path in proposer_state.rglob('used-*'))
                if not reserved:
                    if budget.monotonic() > until:
                        raise TimeoutError('no job reservation observed on the proposer')
                    time.sleep(budget.allowance(.02))
            found = wsl_query(args.proposer_wsl_distro, 'pgrep -P %d' % node_pid).split()
            worker = int(found[0]) if found and found[0].isdigit() else None
            linux_pids.update(pid for pid in (node_pid, worker) if pid)
            time.sleep(budget.allowance(.2))
            wsl_root(args.proposer_wsl_distro, 'echo 1 > ' + shlex.quote(cgroot + '/cgroup.kill'))
            tree = cgroup_tree()
            issuer_code, proposer_code = finish(issuer, 90), finish(proposer, 30)
            state = out / (state_prefix + 'issuer')
            alive = wsl_query(args.proposer_wsl_distro, 'for p in %s; do kill -0 $p 2>/dev/null && echo $p; done; true' % ' '.join(str(pid) for pid in (node_pid, worker) if pid)).split()
            proof_line = next((line for line in issuer['log'].text().splitlines() if line.startswith('{') and '"rounds"' in line), None)
            record = {'kind': 'proposer-node-loss', 'phase': label,
                      'injected': 'cgroup.kill of the whole Linux proposer device while its IMC worker was running',
                      'trigger': 'durable job reservation (used-*) present in proposer state, i.e. round in flight',
                      'reservations_at_kill': len(reserved), 'cgroup_tree_after_loss': tree,
                      'node_linux_pid': node_pid, 'worker_linux_pid': worker, 'issuer_exit_code': issuer_code,
                      'proposer_exit_code': proposer_code, 'issuer_log_tail': issuer['log'].text()[-600:],
                      'issuer_progress': (state / 'progress.json').read_text() if (state / 'progress.json').exists() else None,
                      'issuer_pending_exists': (state / 'pending.json').exists(), 'survivors': alive,
                      'accepted_rounds_after_loss': 0 if proof_line is None else sum(1 for r in json.loads(proof_line).get('rounds', []) if r.get('accepted'))}
            record['fail_closed'] = issuer_code != 0 and not record['issuer_pending_exists'] and not alive and record['accepted_rounds_after_loss'] == 0
            receipt.setdefault('faults', []).append(record)
            if not record['fail_closed']:
                raise ValueError('proposer loss did not fail closed: ' + json.dumps(record)[:600])
            return record, None

        def batch(label, resume, rollback, state_prefix='', first_sequence=1, fault=False):
            a, b = endpoint(), endpoint()
            members = [{'ID': 'issuer', 'Endpoint': a, 'Public': issuer_public, 'Role': 'issuer'},
                       {'ID': 'proposer', 'Endpoint': b, 'Public': proposer_public, 'Role': 'worker'}]
            nodes, configs = {}, {}
            for name, address, remote in [('proposer', b, 'issuer'), ('issuer', a, 'proposer')]:
                state = out / (state_prefix + name)
                if not resume:
                    state.mkdir()
                    (state / 'consent.json').write_text(json.dumps({'opt_in': True, 'epoch': 1, 'scope': 'synthetic-public-v1', 'purpose': 'local-network-training'}))
                config = {'id': name, 'endpoint': address, 'remote_id': remote, 'state': str(state),
                          'python': args.python, 'peer': str(ROOT / 'ilaria/runtime/isxprobe/peer.py'),
                          'public_library_root': args.public_library_root, 'issuer_public': role_public,
                          'evaluator_public': evaluator_public, 'members': members, 'rounds': 2,
                          'cpu_percent': 25, 'memory_bytes': 1 << 30, 'traffic_bytes': 4 << 20,
                          'timeout_seconds': max(1, int(budget.allowance(90))), 'learning_rate': .001,
                          'steps': 4, 'resume': resume, 'rollback_at_end': rollback}
                remote_linux = wsl_mode and name == 'proposer'
                if remote_linux:
                    config.update(state=wsl_path(state), python=args.proposer_wsl_python,
                                  peer=wsl_path(ROOT / 'ilaria/runtime/isxprobe/peer.py'),
                                  public_library_root=wsl_path(args.public_library_root) if args.public_library_root else '',
                                  linux_delegated_root=cgroot)
                cfg = out / (label + '-' + name + '.json')
                cfg.write_text(json.dumps(config))
                configs[name] = cfg
                receipt.setdefault('state_paths', {}).setdefault(label, {})[name] = str(state)
                command = [str(binary), '--local-probe', '--network-config', str(cfg)]
                if remote_linux:
                    leaf = cgroot + '/node-' + label
                    receipt['linux_cgroup'].setdefault('node_leaves', []).append(leaf)
                    inner = ('mkdir ' + shlex.quote(leaf) + ' && chown ' + wsl_uid + ':' + wsl_gid + ' ' + shlex.quote(leaf) + ' ' +
                             shlex.quote(leaf + '/cgroup.procs') + ' && echo $$ > ' + shlex.quote(leaf + '/cgroup.procs') + ' && exec setpriv --reuid=' + wsl_uid +
                             ' --regid=' + wsl_gid + ' --init-groups env HOME=' + shlex.quote(wsl_home) +
                             ' GOMAXPROCS=2 SWYPIK_SWARM_TRAINING_ENABLED=true PYTHONDONTWRITEBYTECODE=1 ' +
                             shlex.quote(wsl_path(linux_binary)) + ' --local-probe --network-config ' + shlex.quote(wsl_path(cfg)))
                    command = ['wsl', '-d', args.proposer_wsl_distro, '-u', 'root', '--cd', wsl_path(state), '--exec', 'sh', '-c', inner]
                child = start(label + '-' + name, command, state, secrets[name])
                nodes[name] = child
                if name == 'proposer':
                    ready_end = budget.monotonic() + budget.allowance(15)
                    while not child['log'].ready.is_set():
                        errors()
                        if child['process'].poll() is not None:
                            raise RuntimeError('proposer startup failed: ' + child['log'].text())
                        child['log'].ready.wait(budget.allowance(min(.1, ready_end - budget.monotonic())))
                    if remote_linux:
                        port = int(address.rsplit(':', 1)[1])
                        forward_end = budget.monotonic() + budget.allowance(15)
                        while not windows_listening(port):
                            errors()
                            if child['process'].poll() is not None or budget.monotonic() > forward_end:
                                raise RuntimeError('WSL localhost forwarding not established for proposer port ' + str(port))
                            time.sleep(budget.allowance(.2))
                        pid_text = wsl_query(args.proposer_wsl_distro,
                                             "for p in $(pgrep -u " + wsl_uid + " -f -- '" + guarded_pattern('--network-config ' + wsl_path(cfg)) +
                                             "'); do [ \"$(readlink /proc/$p/exe)\" = '" + wsl_path(linux_binary) + "' ] && echo $p; done | head -1")
                        if not pid_text.isdigit():
                            raise RuntimeError('cannot bind spawned Linux proposer PID')
                        child['linux_pid'] = int(pid_text)
            if fault:
                return fault_probe(label, nodes, state_prefix)
            codes = {name: finish(child) for name, child in nodes.items()}
            if any(codes.values()):
                raise RuntimeError('node exits: ' + str(codes) + '; ' + nodes['issuer']['log'].text() + nodes['proposer']['log'].text())
            proof = next((json.loads(line) for line in nodes['issuer']['log'].text().splitlines() if line.startswith('{') and '"rounds"' in line), None)
            if proof is None:
                raise ValueError('missing actual round proof')
            for round_ in proof['rounds']:
                (linux_pids if wsl_mode else observed_pids).update([round_['remote_os_pid'], round_['worker_pid']])
            validate_rounds(proof, first_sequence, rollback)
            receipt['proofs'].append({'phase': label, 'proof': proof})
            receipt.setdefault('durable_progress', {})[label] = {
                name: {'progress': json.loads((out / (state_prefix + name) / 'progress.json').read_text()),
                       'active_hash': (out / (state_prefix + name) / 'active.json').read_text() if name == 'issuer' else None}
                for name in ('issuer', 'proposer')}
            if rollback and proof['rollback'].get('notice'):
                certificate = proof['rollback']['notice']['certificate']
                receipt.setdefault('rollback_metadata', {})[label] = {
                    name: {'notice_json': (out / (state_prefix + name) / ('rollback-' + str(certificate['after']['sequence']) + '.json')).read_text(),
                           **{field: json.loads((out / (state_prefix + name) / ('history-' + str(certificate[field]['sequence']) + '.json')).read_text())
                              for field in ('before', 'after', 'target')}}
                    for name in ('issuer', 'proposer')}
                receipt.setdefault('progress_validation', {})[label] = validate_journaled_rollback(
                    proof, receipt['durable_progress'][label], receipt['rollback_metadata'][label], role_public, first_sequence + 2)
            else:
                receipt.setdefault('progress_validation', {})[label] = validate_durable_progress(
                    proof, receipt['durable_progress'][label], first_sequence + 2, rollback)
            return proof, configs

        if args.fault_proposer_loss:
            if not wsl_mode:
                raise ValueError('--fault-proposer-loss requires --proposer-wsl-distro')
            receipt['classification'] += '+FAULT_PROPOSER_LOSS'
            batch('faulted', False, False, 'faulted-', fault=True)
            try:
                batch('recovery', False, False, 'recovery-')
            except Exception:
                receipt['recovery_diagnostics'] = {'cgroup_tree': cgroup_tree(),
                                                   'dmesg_tail': (lambda value: value if isinstance(value, str) else value.stdout)(wsl_root(args.proposer_wsl_distro, 'dmesg | tail -n 20')).splitlines()}
                raise
            receipt['limitations'] = ['two OS instances on ONE physical host; the lost node is the whole Linux proposer cgroup (node + IMC worker)',
                                      'recovery is a fresh issuer/proposer network after the loss, not resumption of the interrupted round',
                                      'tiny synthetic IMC; energy unmeasured']
            receipt['status'] = 'PASS'
        else:
            first, configs = batch('initial', False, not args.resume_continuation)
            replay = start('restart-replay', [str(binary), '--local-probe', '--network-config', str(configs['issuer'])], out / 'issuer', secrets['issuer'])
            replay_code = finish(replay, 15)
            if replay_code == 0 or 'restart replay denied before worker allocation' not in replay['log'].text():
                raise ValueError('actual host replay restart not denied')
            receipt['restart_replay'] = {'pid': replay['process'].pid, 'returncode': replay_code, 'denied_before_worker_allocation': True}
            if args.resume_continuation:
                second, _ = batch('resumed', True, False, first_sequence=4)
                if (second['rounds'][0]['parent'] != first['rounds'][-1]['active_hash'] or second['rounds'][0]['genesis'] != first['rounds'][0]['genesis']):
                    raise ValueError('resumed sequence 4 did not consume committed parent/genesis')
                receipt['next_sequence_continuation'] = True
                receipt['fresh_process_validation'] = validate_fresh_processes(first, second)
                batch('rollback', False, True, 'rollback-')
            if args.rollback_resume_continuation:
                second, _ = batch('resumed', True, False, first_sequence=5)
                if (second['rounds'][0]['parent'] != first['rollback']['to'] or
                        second['rounds'][0]['genesis'] != first['rounds'][0]['genesis']):
                    raise ValueError('resumed sequence 5 did not consume rolled-back parent/genesis')
                receipt['next_sequence_continuation'] = True
                receipt['rollback_then_resume_proved'] = True
                receipt['fresh_process_validation'] = validate_fresh_processes(first, second)
            receipt['limitations'] = ['same Windows host, loopback TCP, tiny synthetic IMC; no two-host or energy proof',
                                      'lost rollback ACK catch-up and crash recovery are not exercised by this TCP run']
            if wsl_mode:
                receipt['limitations'][0] = ('two OS instances on ONE physical host: Windows NT issuer dials a Linux (WSL2) proposer through '
                                             'WSL localhost forwarding; not two physical machines; tiny synthetic IMC; energy unmeasured')
                receipt['limitations'].append('Linux worker ran unprivileged under an operator-delegated cgroup v2 root (cpu.max/memory.max/pids.max)')
            if not args.rollback_resume_continuation:
                receipt['limitations'].append('continuation after rollback remains unproved in this proof mode')
            receipt['status'] = 'PASS'
    except Exception as exc:
        receipt['status'], receipt['error'] = 'FAIL', type(exc).__name__ + ': ' + str(exc)
    finally:
        for child in children:
            stop_owned(child['process'], budget)
        if keepalive is not None:
            stop_owned(keepalive, budget)
            receipt['wsl_keepalive']['returncode'] = keepalive.poll()
        for child in children:
            try:
                child['log'].thread.join(timeout=budget.allowance(.5, cleanup=True))
            except TimeoutError:
                pass
            receipt['children'].append({'label': child['label'], 'pid': child['process'].pid, 'returncode': child['process'].poll(),
                                         'output_thread_stopped': not child['log'].thread.is_alive(),
                                         **({'linux_pid': child['linux_pid']} if 'linux_pid' in child else {})})
        try:
            receipt['cleanup'] = [{'pid': pid, 'alive': process_alive(pid)} for pid in sorted(observed_pids)]
            if wsl_mode:
                wsl_query(args.proposer_wsl_distro, "pkill -f -- '" + guarded_pattern(wsl_path(out)) + "'; true")
                alive = wsl_query(args.proposer_wsl_distro, 'for p in ' + ' '.join(str(p) for p in sorted(linux_pids)) +
                                  '; do kill -0 $p 2>/dev/null && echo $p; done; true') if linux_pids else ''
                receipt['cleanup_linux'] = [{'pid': pid, 'alive': str(pid) in alive.split()} for pid in sorted(linux_pids)]
            if wsl_mode and cgroup_created:
                receipt['linux_cgroup']['teardown'] = wsl_root(args.proposer_wsl_distro,
                    'R=' + shlex.quote(cgroot) + '; for i in 1 2 3 4 5 6 7 8 9 10; do find "$R" -mindepth 1 -depth -type d -exec rmdir {} + 2>/dev/null; '
                    'rmdir "$R" 2>/dev/null && break; sleep .3; done; [ -e "$R" ] && echo LEFT || echo REMOVED')
            receipt['source_pin_drift'] = [name for name, expected in pins.items() if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != expected]
        except Exception as exc:
            receipt['status'], receipt['cleanup_error'] = 'FAIL', str(exc)
        if receipt['status'] == 'PASS':
            try:
                receipt['recorded_acceptance_validation'] = validate_recorded_receipt(receipt)
            except Exception as exc:
                receipt['status'], receipt['validation_error'] = 'FAIL', str(exc)
        receipt['elapsed_seconds'] = budget.monotonic() - budget.started
        if (budget.remaining(cleanup=True) < 0 or receipt.get('source_pin_drift') or any(item['alive'] for item in receipt.get('cleanup', []) + receipt.get('cleanup_linux', [])) or
                receipt.get('linux_cgroup', {}).get('teardown') == 'LEFT' or
                any(item['returncode'] is None or not item['output_thread_stopped'] for item in receipt['children'])):
            receipt['status'] = 'FAIL'
        (out / 'receipt.json').write_text(json.dumps(receipt, indent=2, allow_nan=False) + '\n')
        print(json.dumps({'status': receipt['status'], 'receipt': str(out / 'receipt.json'), 'elapsed_seconds': receipt['elapsed_seconds'],
                          'next_sequence_continuation': receipt['next_sequence_continuation'], 'error': receipt.get('error')}))
    return 0 if receipt['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
