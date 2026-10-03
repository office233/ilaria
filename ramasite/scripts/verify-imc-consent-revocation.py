#!/usr/bin/env python3
"""One opt-in, bounded, synthetic canonical IMC consent-revocation observation.

The production checkout is read-only. No model wrappers, overlays, retries or
checkpoint payload reads are permitted. A running proposal is not by itself
proof that the training loop was sampled; that distinction is explicit.
"""
from datetime import datetime, timezone
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
import time

MODEL_SHA = '650f4cad06d80760a03fa4396bb2cce27364bd596b8002f39ec02d595205274c'
HELPER_SHA = '1e286f822b4444944e5ec372afbe090722f7432c2f04faa4c20e2fc1987acf91'
CONSENT = {'opt_in': True, 'epoch': 1, 'scope': 'synthetic-public-v1',
           'purpose': 'local-network-training'}
PROGRESS_FIELDS = {'session', 'genesis', 'parent', 'lineage', 'sequence'}
METADATA_BYTES = 16384
OUTPUT_BYTES = 65536


class Unproved(RuntimeError):
    pass


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_helpers(checkout):
    path = checkout / 'ramasite/scripts/verify-imc-network.py'
    if sha(path) != HELPER_SHA:
        raise ValueError('frozen bounded runner dependency differs')
    spec = importlib.util.spec_from_file_location('frozen_imc_network_helpers', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical(value):
    return json.dumps(value, separators=(',', ':'), sort_keys=True,
                      allow_nan=False).encode('ascii')


def read_small(path, maximum=METADATA_BYTES):
    with Path(path).open('rb') as stream:
        raw = stream.read(maximum + 1)
    if len(raw) > maximum:
        raise ValueError('own scalar metadata byte bound exceeded')
    return raw


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate scalar metadata key')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite scalar metadata')))


def atomic_revoke(state):
    path = state / 'consent.json'
    if strict_json(read_small(path)) != CONSENT:
        raise ValueError('fresh consent changed before owned revocation')
    revoked = dict(CONSENT, opt_in=False)
    temporary = state / 'consent-revoked.tmp'
    with temporary.open('xb') as stream:
        stream.write(canonical(revoked))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    return {'monotonic': time.monotonic(), 'utc': datetime.now(timezone.utc).isoformat(),
            'consent_sha256': sha(path)}


def scalar_state(issuer, proposer):
    result = {}
    for name, state in [('issuer', issuer), ('proposer', proposer)]:
        item = {'progress': None, 'active': None, 'pending': None, 'reservations': []}
        for field, filename in [('progress', 'progress.json'), ('active', 'active.json'),
                                ('pending', 'pending.json')]:
            path = state / filename
            if path.exists():
                raw = read_small(path)
                if field == 'active':
                    value = raw.decode('ascii')
                    if len(value) != 64 or any(ch not in '0123456789abcdef' for ch in value):
                        raise ValueError('invalid own active scalar hash')
                else:
                    value = strict_json(raw)
                item[field] = {'sha256': hashlib.sha256(raw).hexdigest(), 'value': value}
        for path in sorted(state.glob('used-*')):
            if len(item['reservations']) >= 6:
                raise ValueError('own reservation count bound exceeded')
            if read_small(path, 8) != b'reserved':
                raise ValueError('invalid own reservation marker')
            suffix = path.name[5:]
            if len(suffix) != 64 or any(ch not in '0123456789abcdef' for ch in suffix):
                raise ValueError('invalid own reservation identity')
            item['reservations'].append(path.name)
        # Names alone establish that no accepted-version metadata was added.
        item['committed_versions'] = sorted(path.name for path in state.glob('committed-*.json'))
        item['history_versions'] = sorted(path.name for path in state.glob('history-*.json'))
        result[name] = item
    return result


def validate_initial(state):
    issuer, proposer = state['issuer'], state['proposer']
    if not issuer['progress'] or not issuer['active']:
        return False
    progress = issuer['progress']['value']
    if (not isinstance(progress, dict) or set(progress) != PROGRESS_FIELDS or
            type(progress['sequence']) is not int or progress['sequence'] != 0):
        raise Unproved('round completed before active observation')
    for field in PROGRESS_FIELDS - {'sequence'}:
        if not isinstance(progress[field], str) or len(progress[field]) != 64 or any(
                ch not in '0123456789abcdef' for ch in progress[field]):
            raise ValueError('invalid initial progress identity')
    if (progress['parent'] != progress['genesis'] or progress['lineage'] != progress['genesis'] or
            issuer['active']['value'] != progress['genesis'] or proposer['progress'] is not None or
            issuer['pending'] or proposer['pending'] or issuer['committed_versions'] or
            proposer['committed_versions']):
        raise Unproved('fresh uncommitted training boundary not observed')
    expected = 'used-' + hashlib.sha256((progress['session'] + 'round-1').encode()).hexdigest()
    return len(proposer['reservations']) == 2 and expected in proposer['reservations']


def validate_no_publication(before, after):
    if not validate_initial(before):
        raise ValueError('missing exact initial reservation boundary')
    for name in ('issuer', 'proposer'):
        for field in ('progress', 'active', 'committed_versions', 'history_versions'):
            if before[name][field] != after[name][field]:
                raise ValueError('post-revocation adoption/progress mutation: ' + name + '/' + field)
        if before[name]['reservations'] != after[name]['reservations']:
            raise ValueError('post-revocation additional work reservation')
        if after[name]['pending'] is not None:
            raise Unproved('pending publication retained; outcome uncertain, no success claim')
    return {'adopted_checkpoint': False, 'progress_changed': False,
            'additional_reservation': False, 'pending': 'ABSENT',
            'journal_outcome': 'NOT_READ_OR_INFERRED'}


def validate_phase(raw, state, worker, issuer_public, proposer_public, evaluator_public):
    if len(raw) > 4096:
        raise ValueError('synthetic phase record byte bound')
    marker = strict_json(raw)
    fields = {'version', 'phase', 'step', 'worker_pid', 'issued_job_hash',
              'current_parent_checkpoint_hash', 'signed_job', 'issuer_signature',
              'created_unix_ms', 'monotonic_ns', 'hold_ms'}
    if (not isinstance(marker, dict) or set(marker) != fields or canonical(marker) != raw or
            any(type(marker[key]) is not int for key in ('version', 'step', 'worker_pid', 'created_unix_ms', 'monotonic_ns', 'hold_ms')) or
            marker['version'] != 1 or marker['phase'] != 'after-first-optimizer-step' or
            marker['step'] != 1 or marker['worker_pid'] != worker['pid'] or not 0 <= marker['hold_ms'] <= 1000):
        raise ValueError('invalid synthetic post-step phase record')
    signed = marker['signed_job'].encode('ascii')
    job = strict_json(signed)
    if hashlib.sha256(signed).hexdigest() != marker['issued_job_hash'] or canonical(job) != signed:
        raise ValueError('phase exact issued-job hash/canonical binding')
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(issuer_public)).verify(bytes.fromhex(marker['issuer_signature']), signed)
    progress = state['issuer']['progress']['value']
    expected = {'protocol_version': 2, 'issuer_id': 'issuer', 'expert_id': 'synthetic-imc',
                'session_id': progress['session'], 'round_sequence': 1, 'round_id': 'round-1',
                'genesis_checkpoint_hash': progress['genesis'], 'current_parent_checkpoint_hash': progress['parent'],
                'lineage_hash': progress['lineage'], 'dataset_scope': CONSENT['scope'],
                'authorized_purpose': CONSENT['purpose'], 'proposer_id': 'proposer', 'evaluator_id': 'evaluator',
                'proposer_key_hash': hashlib.sha256(bytes.fromhex(proposer_public)).hexdigest(),
                'evaluator_key_hash': hashlib.sha256(bytes.fromhex(evaluator_public)).hexdigest(), 'consent_epoch': 1}
    fields = set(expected) | {'nonce', 'lease_fence', 'deadline_unix_ms', 'recipe_json',
                             'training_recipe_hash', 'model_config_hash', 'curriculum_manifest_hash'}
    if (set(job) != fields or any(job.get(key) != value for key, value in expected.items()) or
            any(type(job[key]) is not int or job[key] < 1 for key in ('protocol_version', 'round_sequence', 'consent_epoch', 'lease_fence', 'deadline_unix_ms')) or
            marker['current_parent_checkpoint_hash'] != progress['parent'] or
            marker['created_unix_ms'] >= job['deadline_unix_ms'] or
            marker['created_unix_ms'] < worker['created_100ns'] // 10000 - 11644473600000 or
            marker['monotonic_ns'] <= 0 or len(job['nonce']) != 64 or any(ch not in '0123456789abcdef' for ch in job['nonce'])):
        raise ValueError('phase signed authority/current lineage/deadline binding')
    recipe = strict_json(job['recipe_json'].encode())
    config = {'d_model': 32, 'eos_token_id': 15, 'ffn_dim': 64, 'max_seq_len': 8,
              'n_heads': 4, 'n_kv_heads': 2, 'n_layers': 1, 'vocab_size': 16}
    expected_recipe = {'config': config, 'learning_rate': .001, 'max_delta_norm': 20.,
                       'min_improvement': .0001, 'seed': 1701, 'steps': 64, 'version': 1}
    if (recipe != expected_recipe or hashlib.sha256(canonical(recipe)).hexdigest() != job['training_recipe_hash'] or
            hashlib.sha256(canonical(config)).hexdigest() != job['model_config_hash']):
        raise ValueError('phase exact signed recipe/config binding')
    fixture = {}
    for split, starts in [('train', range(0, 6)), ('eval', range(6, 10)), ('anchors', range(10, 14)), ('sealed', range(14, 15))]:
        ids = [[(start + i) % 15 for i in range(8)] for start in starts]
        fixture[split] = [ids, [row[1:] + [15] for row in ids]]
    if hashlib.sha256(canonical(fixture)).hexdigest() != job['curriculum_manifest_hash']:
        raise ValueError('phase exact synthetic fixture binding')
    nonce_reservation = 'used-' + hashlib.sha256((job['session_id'] + job['nonce']).encode()).hexdigest()
    if nonce_reservation not in state['proposer']['reservations']:
        raise ValueError('phase exact issued nonce lacks durable reservation')
    return marker


def validate_activity(first, second, reservation, training_phase=None):
    fields = ('pid', 'created_100ns')
    if (any(first[key] != second[key] for key in fields) or
            type(first['pid']) is not int or first['pid'] <= 0 or
            first['alive'] is not True or second['alive'] is not True or
            second['cpu_ns'] <= first['cpu_ns'] or
            second['monotonic'] <= first['monotonic'] or not validate_initial(reservation)):
        raise Unproved('fresh owned worker CPU increase/reservation not observed')
    if training_phase is None:
        raise Unproved('active canonical proposal observed; exact training-loop phase unproved')
    if not first['monotonic'] * 1e9 <= training_phase['monotonic_ns'] <= second['monotonic'] * 1e9:
        raise Unproved('CPU observations did not span genuine post-step marker')
    return {'worker_pid': first['pid'], 'worker_created_100ns': first['created_100ns'],
            'cpu_delta_ns': second['cpu_ns'] - first['cpu_ns'],
            'sample_seconds': second['monotonic'] - first['monotonic'],
            'training_phase': training_phase}


class WindowsJob:
    """Outer owned containment, assigned before resume; no global PID scans.

    QueryJobObject's member list is the only discovery source. Each process
    handle is retained with its creation time, preventing PID reuse attribution.
    The production worker remains in its existing nested OS Job.
    """
    def __init__(self, cpu=25, memory=2 << 30, processes=16):
        if os.name != 'nt':
            raise OSError('this observation requires Windows owned Job APIs')
        self.k = ctypes.WinDLL('kernel32', use_last_error=True)
        self.n = ctypes.WinDLL('ntdll', use_last_error=True)
        H, D, B = wintypes.HANDLE, wintypes.DWORD, wintypes.BOOL
        definitions = {
            'CreateJobObjectW': ([ctypes.c_void_p, wintypes.LPCWSTR], H),
            'SetInformationJobObject': ([H, ctypes.c_int, ctypes.c_void_p, D], B),
            'QueryInformationJobObject': ([H, ctypes.c_int, ctypes.c_void_p, D, ctypes.POINTER(D)], B),
            'AssignProcessToJobObject': ([H, H], B), 'TerminateJobObject': ([H, wintypes.UINT], B),
            'CloseHandle': ([H], B), 'OpenProcess': ([D, B, D], H),
            'GetProcessTimes': ([H] + [ctypes.POINTER(wintypes.FILETIME)] * 4, B),
            'WaitForSingleObject': ([H, D], D),
            'QueryFullProcessImageNameW': ([H, D, wintypes.LPWSTR, ctypes.POINTER(D)], B),
        }
        for name, (arguments, result) in definitions.items():
            method = getattr(self.k, name)
            method.argtypes, method.restype = arguments, result
        self.n.NtResumeProcess.argtypes = [H]
        self.n.NtResumeProcess.restype = ctypes.c_long

        class Basic(ctypes.Structure):
            _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64),
                        ('flags', D), ('minimum', ctypes.c_size_t), ('maximum', ctypes.c_size_t),
                        ('processes', D), ('affinity', ctypes.c_size_t), ('priority', D), ('scheduling', D)]
        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in
                        ('reads', 'writes', 'others', 'read_bytes', 'write_bytes', 'other_bytes')]
        class Extended(ctypes.Structure):
            _fields_ = [('basic', Basic), ('io', IO), ('process_memory', ctypes.c_size_t),
                        ('job_memory', ctypes.c_size_t), ('peak_process', ctypes.c_size_t),
                        ('peak_job', ctypes.c_size_t)]
        self.Extended = Extended
        self.handle, self.handles, self.first_close_error = self.k.CreateJobObjectW(None, None), {}, None
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            limits = Extended()
            limits.basic.flags = 0x2000 | 0x200 | 0x8  # kill-on-close/job-memory/active-process
            limits.basic.processes, limits.job_memory = processes, memory
            self._set(9, limits)
            cap = (D * 2)(1 | 4, cpu * 100)
            self._set(15, cap)
        except BaseException:
            self.close()
            raise

    def _set(self, kind, value):
        if not self.k.SetInformationJobObject(self.handle, kind, ctypes.byref(value), ctypes.sizeof(value)):
            raise ctypes.WinError(ctypes.get_last_error())

    def assign_resume(self, process):
        if not self.k.AssignProcessToJobObject(self.handle, int(process._handle)):
            process.kill()
            process.wait(timeout=2)
            raise ctypes.WinError(ctypes.get_last_error())
        status = self.n.NtResumeProcess(int(process._handle))
        if status:
            raise OSError('owned suspended process resume failed: ' + hex(status & 0xffffffff))

    def pids(self):
        # Fixed buffer bounds all member discovery; never enumerate unrelated processes.
        raw = ctypes.create_string_buffer(8 + 32 * ctypes.sizeof(ctypes.c_size_t))
        if not self.k.QueryInformationJobObject(self.handle, 3, raw, ctypes.sizeof(raw), None):
            raise ctypes.WinError(ctypes.get_last_error())
        assigned, listed = (wintypes.DWORD * 2).from_buffer(raw)
        if assigned > 32 or listed != assigned:
            raise ValueError('owned Job membership observation incomplete')
        ids = (ctypes.c_size_t * listed).from_buffer(raw, 8)
        return [int(pid) for pid in ids]

    def alive_pids(self):
        result = []
        for pid in self.pids():
            try:
                if self.sample(pid)['alive']:
                    result.append(pid)
            except OSError as exc:
                if getattr(exc, 'winerror', None) != 87:
                    raise
        return result

    def sample(self, pid):
        if pid not in self.handles:
            if pid not in self.pids():
                raise ValueError('refuse process outside this owned Job')
            handle = self.k.OpenProcess(0x1000 | 0x100000, False, pid)
            if not handle:
                raise ctypes.WinError(ctypes.get_last_error())
            self.handles[pid] = handle
        handle = self.handles[pid]
        times = [wintypes.FILETIME() for _ in range(4)]
        if not self.k.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
            raise ctypes.WinError(ctypes.get_last_error())
        integer = lambda value: (value.dwHighDateTime << 32) | value.dwLowDateTime
        status = self.k.WaitForSingleObject(handle, 0)
        if status not in (0, 0x102):
            raise OSError('owned process wait query failed: ' + hex(status))
        return {'pid': pid, 'created_100ns': integer(times[0]),
                'cpu_ns': 100 * (integer(times[2]) + integer(times[3])),
                'monotonic': time.monotonic(),
                'alive': status == 0x102}

    def image_name(self, pid):
        self.sample(pid)  # establishes exact owned retained identity first
        name, length = ctypes.create_unicode_buffer(2048), wintypes.DWORD(2048)
        if not self.k.QueryFullProcessImageNameW(self.handles[pid], 0, name, ctypes.byref(length)):
            raise ctypes.WinError(ctypes.get_last_error())
        return Path(name.value).name.lower()

    def usage(self):
        value = self.Extended()
        if not self.k.QueryInformationJobObject(self.handle, 9, ctypes.byref(value), ctypes.sizeof(value), None):
            raise ctypes.WinError(ctypes.get_last_error())
        return {'peak_job_memory_bytes': value.peak_job, 'read_bytes': value.io.read_bytes,
                'write_bytes': value.io.write_bytes}

    def close(self):
        if self.handle:
            errors = []
            if not self.k.TerminateJobObject(self.handle, 1):
                errors.append('TerminateJobObject: ' + str(ctypes.get_last_error()))
            if not self.k.CloseHandle(self.handle):
                errors.append('CloseHandle(Job): ' + str(ctypes.get_last_error()))
            self.handle = None
            if errors:
                self.first_close_error = '; '.join(errors)
        return self.first_close_error

    def release_handles(self):
        errors = []
        for handle in self.handles.values():
            if not self.k.CloseHandle(handle):
                errors.append(str(ctypes.get_last_error()))
        self.handles.clear()
        if errors:
            raise OSError('owned observation handle close failure: ' + '; '.join(errors))


def main(argv=None):
    entered = time.monotonic()
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('--checkout', required=True)
    parser.add_argument('--python', required=True)
    parser.add_argument('--public-library-root', required=True)
    parser.add_argument('--temp-root', required=True)
    parser.add_argument('--absolute-deadline', required=True)
    parser.add_argument('--expected-adapter-sha256', required=True)
    parser.add_argument('--expected-peer-sha256', required=True)
    parser.add_argument('--enable-synthetic-training', action='store_true')
    args = parser.parse_args(argv)
    if not args.enable_synthetic_training:
        parser.error('explicit --enable-synthetic-training required')
    checkout, python, library, parent = (Path(getattr(args, name)).resolve() for name in
                                        ('checkout', 'python', 'public_library_root', 'temp_root'))
    if os.name != 'nt' or not python.is_file() or not (library / 'cryptography').is_dir() or not parent.is_dir():
        parser.error('Windows plus explicit existing Python/public cryptography/evidence paths required')
    sys.path.insert(0, str(library))  # explicit public dependency, no ambient user-site
    for path, expected in [('swypik-os/core/imcnetwork/adapter.go', args.expected_adapter_sha256),
                           ('ilaria/runtime/isxprobe/peer.py', args.expected_peer_sha256),
                           ('ilaria/forge/imc_model.py', MODEL_SHA)]:
        if len(expected) != 64 or sha(checkout / path) != expected:
            raise ValueError('frozen source differs: ' + path)
    helper = load_helpers(checkout)
    budget = helper.Budget(datetime.fromisoformat(args.absolute_deadline.replace('Z', '+00:00')), 115, 10)
    budget.started = entered  # includes initial path/hash/import setup
    budget.allowance(105)
    out = Path(tempfile.mkdtemp(prefix='bounded-revocation-', dir=parent))
    receipt = {'format': 'imc-synthetic-consent-revocation-v1', 'status': 'INCOMPLETE',
               'classification': 'SYNTHETIC_IMC_CPU_LOOPBACK_DIAGNOSTIC_HOLD',
               'absolute_deadline': args.absolute_deadline, 'maximum_seconds': 115,
               'cleanup_reserve_seconds': 10, 'children': [], 'cleanup': [],
               'bounds': {'outer_job_cpu_percent': 25, 'outer_job_memory_bytes': 2 << 30,
                          'outer_job_processes': 16, 'worker_cpu_percent': 25,
                          'worker_memory_bytes': 1 << 30, 'worker_processes': 1,
                          'node_traffic_bytes_each': 4 << 20, 'socket_frame_bytes': 256 << 10,
                          'stdout_bytes_each': OUTPUT_BYTES, 'phase_bytes': 4096,
                          'metadata_bytes_each': METADATA_BYTES, 'steps': 64, 'phase_hold_ms': 1000,
                          'consent_poll_ms': 50},
               'limitations': ['one Windows host/loopback/synthetic CPU fixture only',
                               'revocation during ongoing training task after real first backward/optimizer step',
                               'diagnostic hold permits observation; not preemption of a hung native/GPU instruction',
                               'journal/checkpoint payloads not read; pending uncertainty prevents success',
                               'polling/scheduling/filesystem latency are not hard real-time guarantees']}
    children, pins = [], {}
    env = dict(os.environ, GOWORK='off', GOTOOLCHAIN='local', GOPROXY='off', GOSUMDB='off',
               GOMAXPROCS='2', GOTMPDIR=str(out), SWYPIK_SWARM_TRAINING_ENABLED='true')
    binary = out / 'network-node.exe'

    def errors():
        budget.allowance(105)
        for child in children:
            if child['log'].error:
                raise ValueError(child['label'] + ': ' + child['log'].error)
            if child['job'].handle:
                for pid in child['job'].pids():
                    try:
                        child['job'].sample(pid)
                    except OSError as exc:
                        # Short-lived build descendants may exit between the
                        # owned Job snapshot and OpenProcess. ERROR_INVALID_PARAMETER
                        # is the sole absence case; permission/query errors fail.
                        if getattr(exc, 'winerror', None) != 87:
                            raise

    def start(label, command, cwd, secret=None):
        errors()
        job = WindowsJob()
        process = None
        try:
            process = subprocess.Popen(command, stdin=subprocess.PIPE if secret else subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=cwd, env=env,
                                       creationflags=subprocess.CREATE_NO_WINDOW | 0x4)
            child = {'label': label, 'process': process, 'job': job,
                     'log': helper.BoundedOutput(process.stdout, out / (label + '.log'), OUTPUT_BYTES)}
            children.append(child)
            job.assign_resume(process)
            job.sample(process.pid)
            if secret:
                process.stdin.write(canonical(secret) + b'\n'); process.stdin.close()
            return child
        except BaseException:
            job.close()
            if process and process.poll() is None:
                process.kill()
            raise

    def finish(child, ceiling):
        code = budget.wait(child['process'], ceiling, errors)
        child['log'].thread.join(timeout=budget.allowance(1))
        if child['log'].thread.is_alive():
            raise TimeoutError('owned output drain did not join')
        errors()
        return code

    try:
        template = '{{with .Module}}{{if eq .Dir ' + json.dumps(str(checkout / 'swypik-os')) + '}}{{$.Dir}}|{{join $.GoFiles ","}}|{{join $.EmbedFiles ","}}{{end}}{{end}}'
        listing = start('go-closure', ['go', 'list', '-deps', '-f', template, './cmd/imc-peer-probe'], checkout / 'swypik-os')
        if finish(listing, 10):
            raise RuntimeError('public Go closure discovery failed')
        paths = [checkout / relative for relative in ['swypik-os/go.mod', 'swypik-os/go.sum',
                 'ramasite/scripts/verify-imc-network.py', 'ilaria/runtime/isxprobe/peer.py', 'ilaria/forge/imc_model.py',
                 'ilaria/forge/collective_sleep.py', 'ilaria/forge/atomic_io.py']]
        for line in listing['log'].text().splitlines():
            if not line:
                continue
            directory, gofiles, embeds = line.split('|')
            for name in (gofiles + ',' + embeds).split(','):
                if name:
                    path = Path(directory) / name
                    path.resolve().relative_to(checkout / 'swypik-os')
                    paths.append(path)
        if not any(path == checkout / 'swypik-os/core/imcnetwork/adapter.go' for path in paths):
            raise ValueError('production CLI closure lacks pinned adapter')
        pins = {str(path.relative_to(checkout)).replace('\\', '/'): sha(path) for path in sorted(set(paths))}
        (out / 'source-pins.json').write_bytes(canonical(pins) + b'\n')
        receipt['runner_sha256'], receipt['production_source_count'] = sha(__file__), len(pins)
        build = start('build', ['go', 'build', '-o', str(binary), './cmd/imc-peer-probe'], checkout / 'swypik-os')
        if finish(build, 55):
            raise RuntimeError('production CLI build failed')
        keys = {name: helper.key() for name in ('issuer', 'proposer', 'role', 'evaluator')}
        receipt['authority_public_keys'] = {name: public for name, (_, public) in keys.items()}
        addresses = {name: helper.endpoint() for name in ('issuer', 'proposer')}
        members = [{'ID': name, 'Endpoint': addresses[name], 'Public': keys[name][1],
                    'Role': 'issuer' if name == 'issuer' else 'worker'} for name in ('issuer', 'proposer')]
        states, nodes = {}, {}
        for name in ('proposer', 'issuer'):
            state = out / name
            state.mkdir(); (state / 'consent.json').write_bytes(canonical(CONSENT))
            states[name] = state
            config = {'id': name, 'endpoint': addresses[name], 'remote_id': 'issuer' if name == 'proposer' else 'proposer',
                      'state': str(state), 'python': str(python), 'peer': str(checkout / 'ilaria/runtime/isxprobe/peer.py'),
                      'public_library_root': str(library), 'issuer_public': keys['role'][1], 'evaluator_public': keys['evaluator'][1],
                      'members': members, 'rounds': 2, 'cpu_percent': 25, 'memory_bytes': 1 << 30,
                      'traffic_bytes': 4 << 20, 'timeout_seconds': max(1, int(budget.allowance(90))),
                      'learning_rate': .001, 'steps': 64, 'resume': False, 'rollback_at_end': False, 'consent_poll_ms': 50}
            if name == 'proposer':
                config.update(synthetic_phase_probe=True, synthetic_phase_hold_ms=1000)
            cfg = out / (name + '-config.json'); cfg.write_bytes(canonical(config))
            secret = {'transport_private': keys[name][0], 'role_private': keys['role'][0] if name == 'issuer' else keys['proposer'][0],
                      'evaluator_private': keys['evaluator'][0] if name == 'issuer' else ''}
            nodes[name] = start(name, [str(binary), '--local-probe', '--network-config', str(cfg)], state, secret)
            if name == 'proposer':
                end = time.monotonic() + budget.allowance(15)
                while not nodes[name]['log'].ready.is_set():
                    errors()
                    if nodes[name]['process'].poll() is not None:
                        raise RuntimeError('proposer startup failed')
                    if time.monotonic() >= end:
                        raise TimeoutError('proposer bounded readiness timeout')
                    time.sleep(min(.01, budget.allowance(.01)))
        first, before = None, None
        observation_end = time.monotonic() + budget.allowance(40)
        marker_path = states['proposer'] / 'synthetic-phase.json'
        while time.monotonic() < observation_end:
            errors()
            if any(node['process'].poll() is not None for node in nodes.values()):
                raise Unproved('peer exited before active canonical training observation')
            snapshot = scalar_state(states['issuer'], states['proposer'])
            if validate_initial(snapshot):
                job = nodes['proposer']['job']
                worker_ids = [pid for pid in job.alive_pids() if pid != nodes['proposer']['process'].pid and
                              job.image_name(pid) == python.name.lower()]
                if len(worker_ids) != 1:
                    raise Unproved('one exact owned proposer worker not observed')
                sample = job.sample(worker_ids[0])
                if first is None:
                    first = sample
                if marker_path.exists():
                    marker = validate_phase(read_small(marker_path, 4096), snapshot, sample,
                                            keys['role'][1], keys['proposer'][1], keys['evaluator'][1])
                    activity = validate_activity(first, sample, snapshot, marker)
                    # The post-step hold is still live when the owned consent changes.
                    if sample['monotonic'] * 1e9 >= marker['monotonic_ns'] + marker['hold_ms'] * 1000000:
                        raise Unproved('post-step observation hold finished before revocation')
                    before = scalar_state(states['issuer'], states['proposer'])
                    if not validate_initial(before):
                        raise Unproved('fresh reservation boundary disappeared before revocation')
                    receipt['activity'], receipt['before'] = activity, before
                    receipt['revocation'] = atomic_revoke(states['proposer'])
                    break
            time.sleep(min(.01, budget.allowance(.01)))
        if before is None:
            raise Unproved('no fresh post-step owned worker CPU observation in bounded window')
        hold_end = marker['monotonic_ns'] / 1e9 + marker['hold_ms'] / 1000
        if receipt['revocation']['monotonic'] >= hold_end:
            raise Unproved('atomic revocation completed after the post-step hold')
        stop_deadline = receipt['revocation']['monotonic'] + budget.allowance(10)
        proposer_worker_stopped = None
        while time.monotonic() < stop_deadline:
            errors()
            if proposer_worker_stopped is None and not nodes['proposer']['job'].sample(activity['worker_pid'])['alive']:
                proposer_worker_stopped = time.monotonic()
            if all(node['process'].poll() is not None and not node['job'].alive_pids() for node in nodes.values()):
                break
            time.sleep(min(.01, budget.allowance(.01)))
        if any(node['process'].poll() is None or node['job'].alive_pids() for node in nodes.values()):
            raise RuntimeError('owned peer/worker did not stop naturally within10s after revocation')
        receipt['natural_stop_seconds'] = time.monotonic() - receipt['revocation']['monotonic']
        if proposer_worker_stopped is None or proposer_worker_stopped >= hold_end:
            raise Unproved('worker exit before diagnostic hold ended not established')
        receipt['worker_stop_after_revocation_seconds'] = proposer_worker_stopped - receipt['revocation']['monotonic']
        receipt['worker_exited_before_hold_end'] = True
        for node in nodes.values():
            finish(node, 1)
        proposer_log = nodes['proposer']['log'].text()
        if ('participation consent canceled: participation/data consent revoked' not in proposer_log or
                nodes['proposer']['process'].returncode == 0 or 'context deadline exceeded' in proposer_log):
            raise ValueError('distinct consent monitor cancellation cause missing or replaced')
        receipt['after'] = scalar_state(states['issuer'], states['proposer'])
        receipt['publication_validation'] = validate_no_publication(before, receipt['after'])
        receipt['distinct_consent_cause'] = True
        receipt['status'] = 'PASS'
    except Unproved as exc:
        receipt['status'], receipt['error'] = 'UNPROVED', str(exc)
    except Exception as exc:
        receipt['status'], receipt['error'] = 'FAIL', type(exc).__name__ + ': ' + str(exc)
    finally:
        for child in children:
            def cleanup_error(exc, child=child):
                receipt['status'] = 'FAIL'
                receipt.setdefault('cleanup_errors', []).append(child['label'] + ': ' + str(exc))
            try:
                receipt.setdefault('job_usage', {})[child['label']] = child['job'].usage()
            except Exception as exc:
                cleanup_error(exc)
            # Closing containment must run even after a failed usage query.
            try:
                error = child['job'].close()
                if error:
                    raise OSError(error)
            except Exception as exc:
                cleanup_error(exc)
            try:
                child['process'].wait(timeout=budget.allowance(1, cleanup=True))
                child['log'].thread.join(timeout=budget.allowance(.5, cleanup=True))
                for pid in child['job'].handles:
                    observation = child['job'].sample(pid)
                    receipt['cleanup'].append({'label': child['label'], **observation})
            except Exception as exc:
                cleanup_error(exc)
            finally:
                try:
                    child['job'].release_handles()
                except Exception as exc:
                    cleanup_error(exc)
            receipt['children'].append({'label': child['label'], 'pid': child['process'].pid,
                                        'returncode': child['process'].poll(),
                                        'output_thread_stopped': not child['log'].thread.is_alive()})
        receipt['source_pin_drift'] = [name for name, expected in pins.items() if sha(checkout / name) != expected]
        receipt['elapsed_seconds'] = time.monotonic() - entered
        if (budget.remaining(cleanup=True) < 0 or receipt['source_pin_drift'] or
                any(item['alive'] for item in receipt['cleanup']) or
                any(item['returncode'] is None or not item['output_thread_stopped'] for item in receipt['children'])):
            receipt['status'] = 'FAIL'
        (out / 'receipt.json').write_bytes(json.dumps(receipt, indent=2, allow_nan=False).encode() + b'\n')
        print(json.dumps({'status': receipt['status'], 'receipt': str(out / 'receipt.json'),
                          'elapsed_seconds': receipt['elapsed_seconds'], 'error': receipt.get('error')}))
    return 0 if receipt['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
