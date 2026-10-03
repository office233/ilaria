"""Exercise the three independent effects CLIs without a model or network.

All authority, files, journals and the publicly known Ed25519 test key live in
a temporary directory. This is an integration gate, not a production supervisor.
"""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time


REQUEST_FIELDS = (
    "protocol_version", "request_id", "module_hash", "function",
    "effect", "capability", "path",
)
# RFC 8032, test vector 1. This key is public test material, never production trust.
TEST_SEED = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
TEST_PUBLIC = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
CONTENT = b"Nexus effects v1\n"


def encoded(value: object) -> str:
    # Go encoding/json uses these escapes even with UTF-8 output. Field order
    # comes from the generated DTO, never from sorted arbitrary input keys.
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            .replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")
            .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"))


def request_hash(request: dict) -> str:
    ordered = {name: request[name] for name in REQUEST_FIELDS}
    return hashlib.sha256(encoded(ordered).encode("utf-8")).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(encoded(value) + "\n", encoding="utf-8")


def run(command: list[str], *, data: str | None = None, success: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(command, input=data, text=True, encoding="utf-8",
                            capture_output=True, timeout=30, check=False)
    expected_exit = 0 if success else 1
    if result.returncode != expected_exit:
        raise AssertionError(f"unexpected exit {result.returncode}: {command[0]}\n{result.stderr}\n{result.stdout}")
    return result


class Guest:
    def __init__(self, swyp: str, source: Path, run_id: str, timeout: str = "15s"):
        self.process = subprocess.Popen(
            [swyp, "core-broker", "--run-id", run_id, "--timeout", timeout, str(source)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
        )
        self.lines: queue.Queue[str] = queue.Queue()
        self.errors: list[str] = []

        def read_lines() -> None:
            assert self.process.stdout is not None
            for line in self.process.stdout:
                self.lines.put(line)
            self.lines.put("")

        def read_errors() -> None:
            assert self.process.stderr is not None
            self.errors.append(self.process.stderr.read())

        self.reader = threading.Thread(target=read_lines, daemon=True)
        self.error_reader = threading.Thread(target=read_errors, daemon=True)
        self.reader.start()
        self.error_reader.start()

    def frame(self) -> dict:
        line = self.lines.get(timeout=25)
        if not line:
            raise AssertionError(f"guest ended without a frame: {''.join(self.errors)}")
        return json.loads(line)

    def reply(self, result: dict) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(encoded(result) + "\n")
        self.process.stdin.flush()

    def finish(self, success: bool) -> dict:
        frame = self.frame()
        assert frame["type"] == "completion", frame
        assert frame["status"] == ("succeeded" if success else "failed"), frame
        self.process.wait(timeout=10)
        self.reader.join(timeout=2)
        self.error_reader.join(timeout=2)
        assert self.process.returncode == (0 if success else 1), "".join(self.errors)
        assert self.lines.get(timeout=2) == "", "guest emitted additional frames after completion"
        return frame

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=10)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream is not None:
                stream.close()
        self.reader.join(timeout=2)
        self.error_reader.join(timeout=2)


class Gate:
    def __init__(self, args: argparse.Namespace, temporary: Path):
        self.args = args
        self.directory = temporary
        self.counter = 0
        self.roots = temporary / "granted files"
        self.roots.mkdir()
        (self.roots / "input.txt").write_bytes(CONTENT)
        self.keys = temporary / "trusted-public-keys.json"
        self.registry = {"format": "ilaria-effect-trust-registry-v1", "keys": {
            "integration-test-key": {"executor_id": "integration-executor",
                                     "public_key": base64.b64encode(TEST_PUBLIC).decode(), "revoked": False},
        }}
        write_json(self.keys, self.registry)

    def host(self, request: dict, max_bytes: int = 4096) -> Path:
        self.counter += 1
        suffix = str(self.counter)
        configuration = {
            "journal": str(self.directory / f"journal-{suffix}.jsonl"),
            "executor_id": "integration-executor", "executor_credential": "public-test-credential",
            "signer_key_id": "integration-test-key",
            "signer_private_key": base64.b64encode(TEST_SEED + TEST_PUBLIC).decode(),
            "roots": {"fixture": str(self.roots)},
            "grants": [{"grant_id": f"grant-{suffix}", "request_hash": request_hash(request),
                        "request_id": request["request_id"], "effect": request["effect"],
                        "capability": request["capability"], "task_id": f"task-{suffix}",
                        "node_id": f"node-{suffix}",
                        "root_id": "fixture" if request["effect"] == "fs.read" else "",
                        "max_bytes": max_bytes,
                        "expires_at_unix_ms": int(time.time() * 1000) + 120_000}],
        }
        path = self.directory / f"host-{suffix}.json"
        write_json(path, configuration)
        return path

    def broker(self, request: dict, config: Path) -> dict:
        result = run([self.args.broker, "--config", str(config)], data=encoded(request) + "\n")
        frames = result.stdout.splitlines()
        assert len(frames) == 1, result.stdout
        envelope = json.loads(frames[0])
        assert envelope["request"] == request, envelope
        expected = envelope["expected"]
        # Expected context originates in trusted OS grants/leases, not receipt
        # fields. These fixture identities are chosen before sending the request.
        assert expected["executor_id"] == "integration-executor"
        assert expected["fence"] > 0
        config_data = json.loads(config.read_text(encoding="utf-8"))
        grant = config_data["grants"][0]
        for name in ("task_id", "node_id", "grant_id"):
            assert expected[name] == grant[name]
        return envelope

    def verify(self, envelope: dict, *, accept: bool = True, keys: Path | None = None) -> dict | None:
        for field in ("request", "result", "receipt", "expected"):
            write_json(self.directory / f"{field}.json", envelope[field])
        command = [self.args.verifier, "--keys", str(keys or self.keys)]
        for field in ("request", "result", "receipt", "expected"):
            command += [f"--{field}", str(self.directory / f"{field}.json")]
        result = run(command, success=accept)
        if accept:
            observation = json.loads(result.stdout)
            assert observation["verified"] is True
            assert observation["training_eligible"] is False
            assert observation["privacy_class"] == "local_private"
            assert observation["request_hash"] == request_hash(envelope["request"])
            assert "value" not in observation and "path" not in observation
            return observation
        return None


def execute_gate(args: argparse.Namespace, directory: Path) -> None:
    gate = Gate(args, directory)
    source = directory / "read-and-clock.swyp"
    source.write_text('''fn load()->bytes { return read_file("input.txt"); }
fn now()->u64 { return clock(); }
fn main()->bytes {
    let content: bytes = load();
    let timestamp: u64 = now();
    if timestamp > 0 { return content; } else { return "invalid-clock"; }
}
''', encoding="utf-8")
    module = directory / "module.json"
    run([args.swyp, "ir", "--entry", "main", "-o", str(module), str(source)])
    module_hash = hashlib.sha256(encoded(json.loads(module.read_text(encoding="utf-8"))).encode()).hexdigest()
    guest = Guest(args.swyp, source, "integration")
    successes: list[tuple[dict, Path]] = []
    try:
        for effect, capability, path in (("fs.read", "workspace_read", "input.txt"), ("clock.read", "clock_read", "")):
            request = guest.frame()
            assert set(request) == set(REQUEST_FIELDS)
            assert (request["effect"], request["capability"], request["path"]) == (effect, capability, path)
            assert request["module_hash"] == module_hash
            config = gate.host(request)
            envelope = gate.broker(request, config)
            assert envelope["result"]["status"] == "succeeded", envelope
            gate.verify(envelope)
            successes.append((envelope, config))
            guest.reply(envelope["result"])
        completion = guest.finish(True)
        assert completion["result"]["type"] == "bytes"
        assert base64.b64decode(completion["result"]["value"], validate=True) == CONTENT
        assert completion["module_hash"] == module_hash
    finally:
        guest.close()
    print("PASS effects: source -> safe Core -> scoped OS reads -> signed Ilaria evidence")

    envelope, config = successes[0]
    (gate.roots / "input.txt").write_bytes(b"changed after recorded execution")
    replay = gate.broker(envelope["request"], config)
    assert replay["result"]["status"] == "blocked", replay
    gate.verify(replay, accept=False)
    (gate.roots / "input.txt").write_bytes(CONTENT)
    changed_request = copy.deepcopy(envelope["request"])
    changed_request["path"] = "other.txt"
    mismatch = gate.broker(changed_request, config)
    assert mismatch["result"]["status"] == "denied", mismatch
    gate.verify(mismatch, accept=False)
    print("PASS effects: restart/replay and changed-request denial")

    for field, name, value in (("result", "value", base64.b64encode(b"tampered").decode()),
                               ("receipt", "fence", envelope["receipt"]["fence"] + 1),
                               ("receipt", "signature", base64.b64encode(bytes(64)).decode()),
                               ("expected", "fence", envelope["expected"]["fence"] + 1)):
        changed = copy.deepcopy(envelope)
        changed[field][name] = value
        gate.verify(changed, accept=False)
    for mode in ("revoked", "unknown", "wrong_executor"):
        registry = copy.deepcopy(gate.registry)
        if mode == "revoked":
            registry["keys"]["integration-test-key"]["revoked"] = True
        elif mode == "unknown":
            registry["keys"] = {"different-key": registry["keys"]["integration-test-key"]}
        else:
            registry["keys"]["integration-test-key"]["executor_id"] = "different-executor"
        keys = directory / f"keys-{mode}.json"
        write_json(keys, registry)
        gate.verify(envelope, accept=False, keys=keys)
    print("PASS effects: altered evidence, stale epoch, unknown/revoked/wrong-executor keys")

    guest = Guest(args.swyp, source, "read-limit")
    try:
        request = guest.frame()
        denied = gate.broker(request, gate.host(request, max_bytes=3))
        assert denied["result"]["status"] == "failed", denied
        gate.verify(denied, accept=False)
        guest.reply(denied["result"])
        assert guest.finish(False)["diagnostic"]["code"] == "effect_failed"
    finally:
        guest.close()
    guest = Guest(args.swyp, source, "wrong-result")
    try:
        request = guest.frame()
        wrong = copy.deepcopy(envelope["result"])
        wrong["request_id"] = "different:1"
        guest.reply(wrong)
        assert guest.finish(False)["diagnostic"]["code"] == "invalid_effect_result"
    finally:
        guest.close()
    guest = Guest(args.swyp, source, "no-response", "250ms")
    try:
        assert guest.frame()["effect"] == "fs.read"
        completion = guest.finish(False)
        assert completion["diagnostic"]["code"] == "timeout", completion
    finally:
        guest.close()
    run([args.swyp, "core-run", "--entry", "main", str(source)], success=False)
    unsupported = directory / "unsupported.swyp"
    unsupported.write_text('fn main() { write_file("output.txt", "data"); }', encoding="utf-8")
    result = run([args.swyp, "core-broker", "--run-id", "unsupported", str(unsupported)], success=False)
    frames = [json.loads(line) for line in result.stdout.splitlines()]
    assert len(frames) == 1 and frames[0]["type"] == "completion", frames
    assert not (gate.roots / "output.txt").exists()
    print("PASS effects: read budget, response correlation, deadline and unsupported-effect preflight")


def main() -> None:
    if not __debug__:
        raise RuntimeError("The integration gate requires Python assertions; disable -O/PYTHONOPTIMIZE.")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--swyp", required=True)
    parser.add_argument("--broker", required=True)
    parser.add_argument("--verifier", required=True)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="nexus-effects-") as temporary:
        execute_gate(args, Path(temporary).resolve())
    print("PASS: effects v1 integration gate")


if __name__ == "__main__":
    main()
