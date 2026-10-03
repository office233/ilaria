"""Canonical IMC provider adapter; no OS/model-file authority or training.
The CLI canary creates a tiny random-init IMC in memory, never a promoted model.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import time

MAX_BYTES = 65536
MAX_SAFE = 9007199254740991
ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "specs" / "myriad.manifest.json"


def _object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate field")
        out[key] = value
    return out


def strict_json(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_BYTES:
        raise ValueError("frame bound")
    value = json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=_object,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite")))
    def walk(v, depth=0):
        if depth > 16:
            raise ValueError("depth bound")
        if isinstance(v, str):
            v.encode("utf-8", "strict")
        elif type(v) in (int, float):
            if type(v) is not int or abs(v) > MAX_SAFE:
                raise ValueError("unsafe integer")
        elif isinstance(v, dict):
            for key, item in v.items():
                walk(key, depth + 1)
                walk(item, depth + 1)
        elif isinstance(v, list):
            for item in v:
                walk(item, depth + 1)
        elif v is not None and type(v) is not bool:
            raise ValueError("JSON type")
    walk(value)
    return value


def fields(name):
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {f["name"]: f["type"] for d in manifest["declarations"]
            if d.get("kind") == "record" and d.get("name") == name for f in d["fields"]}


def validate_record(name, value):
    schema = fields(name)
    if type(value) is not dict or set(value) != set(schema):
        raise ValueError("canonical fields")
    for key, kind in schema.items():
        item = value[key]
        if kind in ("u64", "i64"):
            if type(item) is not int or abs(item) > MAX_SAFE or (kind == "u64" and item < 0):
                raise ValueError("canonical integer")
        elif kind == "string" and (type(item) is not str or len(item.encode("utf-8")) > 4096):
            raise ValueError("canonical string")
        elif kind == "string_list" and (type(item) is not list or len(item) > 16 or
                                        any(type(v) is not str or len(v.encode("utf-8")) > 4096 for v in item)):
            raise ValueError("canonical list")
        elif kind == "string_map" and (type(item) is not dict or len(item) > 32 or
                                       any(type(v) is not str or len(v.encode("utf-8")) > 4096 for v in item.values()) or
                                       any(len(k.encode("utf-8")) > 128 for k in item)):
            raise ValueError("canonical map")
    if value["protocol_version"] != 1:
        raise ValueError("unsupported protocol")


def validate_request(request, now_ms=None):
    validate_record("CorticalRequest", request)
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", request["task_id"]):
        raise ValueError("task identity")
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", request["initiator"]) or request["domain_signature"] != "general" or request["desired_output_schema"] != "CorticalResponse":
        raise ValueError("issued identity/output capability")
    if request["modality"] != "text" or request["requested_role"] != "inference":
        raise ValueError("unsupported capability")
    if request["privacy_class"] not in ("LOCAL_PRIVATE", "PUBLIC"):
        raise ValueError("privacy policy")
    if not 1 <= request["compute_budget"] <= 16 or not 0 <= request["confidence_requirement"] <= 1000000:
        raise ValueError("compute bound")
    if not now_ms < request["deadline_unix_ms"] <= now_ms + 30000:
        raise ValueError("deadline")
    if not request["goal"] or len(request["goal"].encode("utf-8")) > 4096:
        raise ValueError("goal bound")
    if request["constraints"] != ["no_training", "no_tools"]:
        raise ValueError("explicit inference-only policy")
    if any(request[k] for k in ("parent_task_id", "evidence_refs", "hippocampus_refs",
                                "working_memory_summary", "tool_observations")):
        raise ValueError("unsupported context/authority")
    return request


def _canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode("utf-8")).hexdigest()


def weights_hash(model):
    """Fingerprint the owned CPU model without materializing a second byte copy."""
    import torch
    digest = hashlib.sha256()
    for key, value in sorted(model.state_dict().items()):
        if value.device.type != "cpu" or not value.is_contiguous():
            raise ValueError("owned contiguous CPU parameters required")
        digest.update(key.encode("utf-8"))
        digest.update(memoryview(value.detach().view(torch.uint8).numpy()).cast("B"))
    return digest.hexdigest()


class IMCProvider:
    """A caller supplies an approved canonical model/tokenizer and provenance.
    No checkpoint is opened here. Decode/encode are the caller's approved tokenizer.
    """
    def __init__(self, model, encode, decode, *, model_hash, tokenizer_hash, canary=False):
        sys.path.insert(0, str(ROOT / "forge"))
        from imc_model import ImcTransformer
        if not isinstance(model, ImcTransformer):
            raise ValueError("canonical IMC required")
        if next(model.parameters()).device.type != "cpu":
            raise ValueError("this adapter currently supports CPU only")
        if any(not re.fullmatch(r"[0-9a-f]{64}", v) for v in (model_hash, tokenizer_hash)):
            raise ValueError("required provenance hashes")
        if model_hash != weights_hash(model):
            raise ValueError("model provenance mismatch")
        self.model, self.encode, self.decode = model, encode, decode
        self.model_hash, self.tokenizer_hash, self.canary = model_hash, tokenizer_hash, canary
        self.config_hash = _canonical_hash(model.cfg.to_json())

    def infer(self, request, cancelled=lambda: False):
        validate_request(request)
        import torch
        ids = self.encode(request["goal"])
        if not ids or len(ids) > self.model.cfg.max_seq_len or any(
                type(i) is not int or not 0 <= i < self.model.cfg.vocab_size for i in ids):
            raise ValueError("tokenizer/context bound")
        wall, cpu = time.perf_counter_ns(), time.process_time_ns()
        generated, forwards = [], 0
        self.model.eval()
        with torch.inference_mode():
            for _ in range(request["compute_budget"]):
                if cancelled() or int(time.time() * 1000) >= request["deadline_unix_ms"]:
                    raise TimeoutError("execution cancelled/expired")
                context = (ids + generated)[-self.model.cfg.max_seq_len:]
                logits = self.model(torch.tensor([context], dtype=torch.long))
                if not torch.isfinite(logits).all():
                    raise ValueError("nonfinite logits")
                forwards += 1
                token = int(torch.argmax(logits[0, -1]))
                generated.append(token)
                if token == self.model.cfg.eos_token_id:
                    break
        if cancelled() or int(time.time() * 1000) >= request["deadline_unix_ms"]:
            raise TimeoutError("execution cancelled/expired")
        response = {
            "protocol_version": 1, "task_id": request["task_id"], "expert_id": "IMC",
            "expert_version": "imc-v1:" + self.config_hash, "hypothesis": self.decode(generated),
            "claims": [], "evidence_refs": ["model:sha256:" + self.model_hash],
            "contradictions": [], "uncertainty_ppm": 1000000, "confidence_ppm": 0,
            "next_expert_suggestions": [], "verification_requirements": ["quality_not_certified"],
            "proposed_swyp_plan": "", "latent_summary": "", "compute_cost": forwards,
            "runtime_metrics": {
                "model_hash": self.model_hash, "tokenizer_hash": self.tokenizer_hash,
                "config_hash": self.config_hash, "canonical_source_hash": hashlib.sha256(
                    (ROOT / "forge" / "imc_model.py").read_bytes()).hexdigest(),
                "canary": str(self.canary).lower(), "device": "cpu",
                "input_tokens": str(len(ids)), "output_tokens": str(len(generated)),
                "forward_passes": str(forwards), "wall_ns": str(time.perf_counter_ns() - wall),
                "cpu_ns": str(time.process_time_ns() - cpu), "execution_status": "succeeded",
                "training": "unavailable", "energy_joules": "unmeasured",
            },
        }
        validate_record("CorticalResponse", response)
        return response


def canary_provider(seed=7):
    sys.path.insert(0, str(ROOT / "forge"))
    import torch
    from imc_model import ImcConfig, ImcTransformer
    torch.set_num_threads(1)
    torch.manual_seed(seed)
    model = ImcTransformer(ImcConfig(vocab_size=32, d_model=32, n_layers=1,
                                    n_heads=4, n_kv_heads=2, ffn_dim=48,
                                    eos_token_id=0, max_seq_len=32))
    return IMCProvider(model, lambda s: [(b % 31) + 1 for b in s.encode("utf-8")[:32]],
                       lambda ids: "[TEST IMC canary; not conversation quality] token_ids=" +
                       ",".join(map(str, ids)), model_hash=weights_hash(model),
                       tokenizer_hash=_canonical_hash({"fixture": "byte-mod31-v1", "vocab": 32}),
                       canary=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--canary", action="store_true", help="Explicit synthetic integration test only")
    parser.add_argument("--public-library-root", type=Path,
                        help="Optional operator-approved installed public dependency directory")
    args = parser.parse_args()
    if args.public_library_root:
        if not args.public_library_root.is_absolute() or not args.public_library_root.is_dir():
            parser.error("public library root must be an existing absolute directory")
        sys.path.insert(0, str(args.public_library_root))
    if not args.canary:
        parser.error("no approved production provider configured; canary requires explicit --canary")
    try:
        raw = sys.stdin.buffer.readline(MAX_BYTES + 2)
        if not raw.endswith(b"\n") or len(raw) > MAX_BYTES + 1:
            raise ValueError("bounded JSONL frame")
        request = validate_request(strict_json(raw[:-1]))
        response = canary_provider().infer(request)
        encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":"),
                             allow_nan=False).encode("utf-8")
        if len(encoded) > MAX_BYTES:
            raise ValueError("response bound")
        sys.stdout.buffer.write(encoded + b"\n")
        sys.stdout.buffer.flush()
    except (ValueError, TimeoutError):
        sys.stderr.write("provider rejected request or execution deadline\n")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
