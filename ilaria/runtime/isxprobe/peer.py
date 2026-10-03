"""Bounded local synthetic IMC worker. Canonical architecture/controller imports only."""
from __future__ import annotations

import base64
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time
import argparse
import tempfile

# Optional explicit PUBLIC dependency root; never enable ambient user-site.
if __name__ == "__main__":
    args = argparse.ArgumentParser()
    args.add_argument("--public-library-root")
    args.add_argument("--network-loop", action="store_true")
    args.add_argument("--network-max-requests",type=int,default=16)
    options = args.parse_args()
    if options.public_library_root:
        library = Path(options.public_library_root)
        if not library.is_absolute() or not (library / "cryptography").is_dir():
            raise ValueError("explicit existing public cryptography library required")
        sys.path.insert(0, str(library))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives import serialization

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "forge"))
from imc_model import ImcConfig, ImcTransformer
from collective_sleep import SleepPolicy, consolidate

FRAME_BYTES = 9 << 20
RECIPE = {"version": 1, "seed": 1701, "steps": 16, "learning_rate": 0.01,
          "max_delta_norm": 20.0, "min_improvement": 0.0001,
          "config": {"vocab_size": 16, "d_model": 32, "n_layers": 1,
                     "n_heads": 4, "n_kv_heads": 2, "ffn_dim": 64,
                     "eos_token_id": 15, "max_seq_len": 8}}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii")


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda x: (_ for _ in ()).throw(ValueError("nonfinite JSON")))


def signed_candidate(candidate, binding, private):
    layout, raw, offset = [], bytearray(), 0
    for name, item in sorted(candidate["delta"].items()):
        data = base64.b64decode(item["data"], validate=True)
        layout.append({"name": name, "shape": item["shape"], "dtype": item["dtype"], "offset": offset, "bytes": len(data)})
        raw.extend(data); offset += len(data)
    meta = dict(binding)
    meta.update(protocol_version=1, expert_id="synthetic-imc", model_config_hash=digest(candidate["recipe"]["config"]),
                genesis_checkpoint_hash=candidate["base_hash"], parameter_delta_hash=hashlib.sha256(raw).hexdigest(),
                curriculum_manifest_hash=candidate["fixture_hash"], training_recipe_hash=candidate["recipe_hash"],
                payload_bytes=len(raw), payload_base64=base64.b64encode(raw).decode("ascii"),
                tensor_layout_json=canonical(layout).decode("ascii"), model_config_json=canonical(candidate["recipe"]["config"]).decode("ascii"),
                recipe_json=canonical(candidate["recipe"]).decode("ascii"), signed_canonical_base64="", signature="")
    unsigned = canonical(meta)
    envelope = dict(meta)
    envelope["signed_canonical_base64"] = base64.b64encode(unsigned).decode("ascii")
    envelope["signature"] = private.sign(unsigned).hex()
    return envelope


def verify_candidate(envelope, public, binding):
    # Bounded canonical bytes and authentication before any model allocation.
    if len(canonical(envelope)) > FRAME_BYTES:
        raise ValueError("oversize envelope")
    allowed = {"protocol_version", "expert_id", "peer_id", "round_id", "model_config_hash", "genesis_checkpoint_hash",
               "parameter_delta_hash", "curriculum_manifest_hash", "training_recipe_hash", "consent_epoch", "lease_fence",
               "nonce", "deadline_unix_ms", "payload_bytes", "payload_base64", "tensor_layout_json", "model_config_json",
               "recipe_json", "signed_canonical_base64", "signer_key_id", "signature"}
    if set(envelope) != allowed:
        raise ValueError("unknown/missing envelope fields")
    required = {"protocol_version", "expert_id", "peer_id", "round_id", "model_config_hash",
                "genesis_checkpoint_hash", "curriculum_manifest_hash", "training_recipe_hash",
                "consent_epoch", "lease_fence", "nonce", "deadline_unix_ms", "signer_key_id"}
    if not isinstance(binding, dict) or set(binding) != required or any(v is None or v == "" for v in binding.values()):
        raise ValueError("incomplete issued authorization")
    for name in ("protocol_version", "consent_epoch", "lease_fence", "deadline_unix_ms"):
        if type(binding[name]) is not int or binding[name] <= 0:
            raise ValueError("invalid issued authorization")
    unsigned = base64.b64decode(envelope["signed_canonical_base64"], validate=True)
    meta = strict_json(unsigned)
    expected = dict(envelope); expected["signed_canonical_base64"] = ""; expected["signature"] = ""
    if canonical(meta) != unsigned or meta != expected:
        raise ValueError("noncanonical/metadata mismatch")
    Ed25519PublicKey.from_public_bytes(public).verify(bytes.fromhex(envelope["signature"]), unsigned)
    for name, value in binding.items():
        if meta.get(name) != value:
            raise ValueError("stale/unknown binding: " + name)
    if meta["protocol_version"] != 1 or time.time() * 1000 >= meta["deadline_unix_ms"]:
        raise ValueError("expired/version")
    raw = base64.b64decode(meta["payload_base64"], validate=True)
    if len(raw) != meta["payload_bytes"] or hashlib.sha256(raw).hexdigest() != meta["parameter_delta_hash"]:
        raise ValueError("raw delta bytes/hash")
    recipe = strict_json(meta["recipe_json"])
    if digest(recipe) != meta["training_recipe_hash"] or digest(recipe["config"]) != meta["model_config_hash"]:
        raise ValueError("recipe/config hash")
    if canonical(recipe["config"]).decode("ascii") != meta["model_config_json"]:
        raise ValueError("config binding")
    layout = strict_json(meta["tensor_layout_json"])
    delta, offset = {}, 0
    for item in layout:
        if set(item) != {"name", "shape", "dtype", "offset", "bytes"} or item["name"] in delta or item["offset"] != offset:
            raise ValueError("layout overlap/duplicate")
        size = item["bytes"]
        if type(size) is not int or size < 0 or offset + size > len(raw):
            raise ValueError("layout size")
        delta[item["name"]] = {"shape": item["shape"], "dtype": item["dtype"], "data": base64.b64encode(raw[offset:offset+size]).decode("ascii")}
        offset += size
    if offset != len(raw):
        raise ValueError("layout trailing bytes")
    return {"recipe": recipe, "recipe_hash": meta["training_recipe_hash"], "fixture_hash": meta["curriculum_manifest_hash"],
            "base_hash": meta["genesis_checkpoint_hash"], "parameter_delta_hash": digest(delta), "delta": delta}


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def fixture(split):
    # Exact sequences disjoint by starting-token ranges; same public next-token rule.
    starts = {"train": range(0, 6), "eval": range(6, 10), "anchors": range(10, 14), "sealed": range(14, 15)}[split]
    rows = [[(start + i) % 15 for i in range(8)] for start in starts]
    ids = torch.tensor(rows, dtype=torch.long)
    targets = torch.cat((ids[:, 1:], torch.full((len(rows), 1), 15, dtype=torch.long)), dim=1)
    return ids, targets


def fixture_hash():
    return digest({s: [x.tolist() for x in fixture(s)] for s in ("train", "eval", "anchors", "sealed")})


def model(recipe):
    if set(recipe) != set(RECIPE) or recipe["config"] != RECIPE["config"]:
        raise ValueError("unknown recipe/model configuration")
    if type(recipe["steps"]) is not int or not 1 <= recipe["steps"] <= 64:
        raise ValueError("steps outside 1..64")
    for name in ("learning_rate", "max_delta_norm", "min_improvement"):
        if type(recipe[name]) not in (float, int) or not math.isfinite(recipe[name]) or recipe[name] <= 0:
            raise ValueError("invalid recipe bound")
    if recipe["version"] != 1 or recipe["seed"] != RECIPE["seed"]:
        raise ValueError("unknown seed/version")
    torch.set_num_threads(1)
    torch.manual_seed(recipe["seed"])
    return ImcTransformer(ImcConfig(**recipe["config"]))


def pack(state):
    return {name: {"shape": list(t.shape), "dtype": "float32-le",
                   "data": base64.b64encode(t.detach().cpu().numpy().astype("<f4").tobytes()).decode("ascii")}
            for name, t in state.items()}


def unpack(payload, state, max_norm):
    if not isinstance(payload, dict) or set(payload) != set(state):
        raise ValueError("shape/name set mismatch")
    result, squared = {}, 0.0
    for name, expected in state.items():
        item = payload[name]
        if set(item) != {"shape", "dtype", "data"} or item["shape"] != list(expected.shape) or item["dtype"] != "float32-le":
            raise ValueError("shape/dtype mismatch")
        raw_size = expected.numel() * 4
        if not isinstance(item["data"], str) or len(item["data"]) != 4 * ((raw_size + 2) // 3):
            raise ValueError("base64/raw byte budget mismatch")
        raw = base64.b64decode(item["data"], validate=True)
        if len(raw) != raw_size:
            raise ValueError("raw length mismatch")
        arr = np.frombuffer(raw, dtype="<f4").copy()
        if not np.isfinite(arr).all():
            raise ValueError("nonfinite tensor")
        squared += float(np.square(arr.astype(np.float64)).sum())
        result[name] = torch.from_numpy(arr.reshape(expected.shape))
    norm = math.sqrt(squared)
    if not math.isfinite(norm) or norm > max_norm:
        raise ValueError("delta norm exceeded")
    return result, norm


@torch.no_grad()
def metrics(m):
    m.eval()
    ids, targets = fixture("eval")
    ce = float(torch.nn.functional.cross_entropy(m(ids).reshape(-1, 16), targets.reshape(-1)))
    ids, targets = fixture("anchors")
    acc = float((m(ids).argmax(-1) == targets).float().mean())
    return {"objective": ce, "anchor_accuracy": acc}


PROMOTION_GATE = "paired-t95-sequence-clusters-min20"
# One-sided 95% Student t critical values; conservative lookup (largest tabulated df <= df).
_T95 = ((1, 6.314), (2, 2.920), (3, 2.353), (4, 2.132), (5, 2.015), (6, 1.943), (7, 1.895), (8, 1.860),
        (9, 1.833), (10, 1.812), (15, 1.753), (20, 1.725), (30, 1.697), (60, 1.671), (120, 1.658))


def t95(df):
    if type(df) is not int or df < 1:
        raise ValueError("t critical value requires integer df >= 1")
    value = _T95[0][1]
    for limit, critical in _T95:
        if df >= limit:
            value = critical
    return value


def per_token_losses(m, split):
    m.eval()
    ids, targets = fixture(split)
    with torch.no_grad():
        logits = m(ids)
    return torch.nn.functional.cross_entropy(logits.reshape(-1, 16), targets.reshape(-1), reduction="none").reshape(ids.shape)


def paired_lower_bound(before, after):
    """One-sided 95% lower bound of the mean paired improvement; each row is one cluster."""
    d = (before - after).double().mean(dim=1)
    n = int(d.numel())
    mean = float(d.mean())
    if n < 2:
        return {"clusters": n, "mean_improvement": mean, "se": None, "lower95": None}
    se = float(d.std(unbiased=True)) / math.sqrt(n)
    return {"clusters": n, "mean_improvement": mean, "se": se, "lower95": mean - t95(n - 1) * se}


def promotion_statistics(base, candidate):
    """Selection uses only the 'eval' split; the disjoint sealed split is report-only and never gates."""
    selection = paired_lower_bound(per_token_losses(base, "eval"), per_token_losses(candidate, "eval"))
    sealed_before, sealed_after = per_token_losses(base, "sealed"), per_token_losses(candidate, "sealed")
    sealed = paired_lower_bound(sealed_before.reshape(-1, 1), sealed_after.reshape(-1, 1))
    return {"selection": selection, "sealed": sealed,
            "sealed_before": float(sealed_before.mean()), "sealed_after": float(sealed_after.mean())}


STRICT_MIN_SELECTION_CLUSTERS = 20


def clusters_required(stats, z_alpha=1.645, z_beta=0.842):
    """Independent clusters needed to detect the observed mean gain (one-sided 5%, power 80%)."""
    if stats["se"] is None or stats["mean_improvement"] <= 0:
        return None
    sd = stats["se"] * math.sqrt(stats["clusters"])
    return math.ceil(((z_alpha + z_beta) * sd / stats["mean_improvement"]) ** 2) if sd > 0 else stats["clusters"]


def strict_promotion(stats, min_clusters=STRICT_MIN_SELECTION_CLUSTERS):
    """Statistically justified rule for real held-out data: enough clusters AND positive 95% lower bound.
    Verdicts are plain codes (no characters that JSON encoders escape differently)."""
    if stats["clusters"] < min_clusters:
        return False, "underpowered"
    if stats["lower95"] is None or stats["lower95"] <= 0:
        return False, "not-significant"
    return True, "significant"


def annotate_promotion(result, base, candidate_model):
    """Signed metrics carry honest statistics; the synthetic fixture keeps the legacy decision rule."""
    stats = promotion_statistics(base, candidate_model)
    selection = stats["selection"]
    strict_ok, strict_reason = strict_promotion(selection)
    before = dict(result.initial_metrics, sealed_objective=stats["sealed_before"])
    candidate = dict(result.history[-1], decision_rule="legacy-mean-min-improvement",
                     decision_statistically_justified=strict_ok, strict_rule=PROMOTION_GATE, strict_rule_verdict=strict_reason,
                     strict_min_selection_clusters=STRICT_MIN_SELECTION_CLUSTERS,
                     selection_clusters=selection["clusters"], selection_mean_improvement=selection["mean_improvement"],
                     selection_se=selection["se"], selection_lower95=selection["lower95"],
                     selection_clusters_required=clusters_required(selection),
                     sealed_objective=stats["sealed_after"], sealed_mean_improvement=stats["sealed"]["mean_improvement"],
                     sealed_lower95_token_level=stats["sealed"]["lower95"], sealed_used_for_selection=False)
    accepted = result.best_step == 1
    return accepted, before, candidate, (candidate if accepted else before)


def propose(recipe):
    m = model(recipe)
    before = copy.deepcopy(m.state_dict())
    base_hash = digest(pack(before))
    before_metrics = metrics(m)
    optimizer = torch.optim.AdamW(m.parameters(), lr=recipe["learning_rate"])
    ids, targets = fixture("train")
    losses = []
    m.train()
    for _ in range(recipe["steps"]):
        optimizer.zero_grad(set_to_none=True)
        loss = m(ids, targets)
        if not torch.isfinite(loss):
            raise ValueError("nonfinite training loss")
        loss.backward()
        torch.nn.utils.clip_grad_norm_(m.parameters(), 1.0)
        optimizer.step()
        losses.append(float(loss.detach()))
    delta = {n: t - before[n] for n, t in m.state_dict().items()}
    encoded = pack(delta)
    return {"recipe": recipe, "recipe_hash": digest(recipe), "fixture_hash": fixture_hash(),
            "base_hash": base_hash, "parameter_delta_hash": digest(encoded), "delta": encoded,
            "train_loss_before": losses[0], "train_loss_after": losses[-1],
            "before": before_metrics, "candidate": metrics(m),
            "raw_delta_bytes": sum(t.numel() * t.element_size() for t in delta.values())}


def network_parent(recipe, packed, expected):
    if digest(packed) != expected:
        raise ValueError("issued current parent hash mismatch")
    m = model(recipe)
    state, _ = unpack(packed, m.state_dict(), 100)
    m.load_state_dict(state, strict=True)
    return m


def network_job(request):
    signed = request["signed_job"]
    job = strict_json(signed)
    if canonical(job).decode("ascii") != signed:
        raise ValueError("noncanonical signed job")
    pins = request["pins"]
    required={"protocol_version","issuer_id","expert_id","session_id","round_sequence","round_id","genesis_checkpoint_hash","current_parent_checkpoint_hash","lineage_hash","model_config_hash","curriculum_manifest_hash","dataset_scope","authorized_purpose","training_recipe_hash","recipe_json","proposer_id","evaluator_id","proposer_key_hash","evaluator_key_hash","nonce","consent_epoch","lease_fence","deadline_unix_ms"}
    if set(job)!=required or any(v is None or v=="" for v in job.values()):raise ValueError("incomplete/unknown network job")
    if job["expert_id"]!="synthetic-imc" or type(job["round_sequence"]) is not int or job["round_sequence"]<1:raise ValueError("network expert/sequence")
    for role in ("issuer", "proposer", "evaluator"):
        if job[role+"_id"] != pins[role+"_id"]:
            raise ValueError("unknown pinned role")
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(pins["issuer_key"])).verify(bytes.fromhex(request["signature"]), signed.encode("ascii"))
    for role in ("proposer", "evaluator"):
        if job[role+"_key_hash"] != hashlib.sha256(bytes.fromhex(pins[role+"_key"])).hexdigest():
            raise ValueError("changed pinned key")
    if job["protocol_version"] != 2 or job["dataset_scope"] != "synthetic-public-v1" or job["authorized_purpose"] != "local-network-training":
        raise ValueError("unauthorized data scope/purpose/version")
    if job["consent_epoch"] < 1 or job["lease_fence"] < 1 or time.time()*1000 >= job["deadline_unix_ms"]:
        raise ValueError("expired consent/fence/deadline")
    recipe = strict_json(job["recipe_json"])
    if digest(recipe) != job["training_recipe_hash"] or digest(recipe["config"]) != job["model_config_hash"] or fixture_hash() != job["curriculum_manifest_hash"]:
        raise ValueError("issued exact recipe/config/fixture")
    return job, recipe


def raw_delta_hash(delta):
    return hashlib.sha256(b"".join(base64.b64decode(item["data"],validate=True) for _,item in sorted(delta.items()))).hexdigest()


PHASE_BYTES = 4096


def phase_probe(request, job):
    probe = request.get("phase_probe")
    if probe is None:
        return None
    if (request["operation"] != "network-propose" or job["dataset_scope"] != "synthetic-public-v1" or
            job["authorized_purpose"] != "local-network-training" or job["proposer_id"] != "proposer" or
            job["round_sequence"] != 1 or job["round_id"] != "round-1" or job["consent_epoch"] != 1 or
            not isinstance(probe, dict) or set(probe) != {"path", "hold_ms"} or
            type(probe["hold_ms"]) is not int or not 0 <= probe["hold_ms"] <= 1000):
        raise ValueError("invalid synthetic phase diagnostic authority")
    path = Path(probe["path"])
    state = Path.cwd()
    if (not path.is_absolute() or path != state / "synthetic-phase.json" or path.exists() or
            path.is_symlink() or any(part.is_symlink() or part.is_junction() for part in (state, *state.parents))):
        raise ValueError("synthetic phase marker must be fresh exact own-state path")
    if time.time() * 1000 >= job["deadline_unix_ms"]:
        raise ValueError("synthetic phase diagnostic expired")
    return probe


def record_training_phase(probe, request, job, step):
    # This call is placed only after real backward, clipping and optimizer.step.
    # It does not inspect model state, tensors, samples, text or private keys.
    if probe is None:
        return
    if step != 1 or time.time() * 1000 >= job["deadline_unix_ms"]:
        raise ValueError("synthetic phase step/deadline")
    phase_probe(request, job)  # recheck exact destination immediately before effect
    record = {"version": 1, "phase": "after-first-optimizer-step", "step": step,
              "worker_pid": os.getpid(), "issued_job_hash": hashlib.sha256(request["signed_job"].encode("ascii")).hexdigest(),
              "current_parent_checkpoint_hash": job["current_parent_checkpoint_hash"],
              "signed_job": request["signed_job"], "issuer_signature": request["signature"],
              "created_unix_ms": int(time.time() * 1000), "monotonic_ns": time.monotonic_ns(),
              "hold_ms": probe["hold_ms"]}
    raw = canonical(record)
    if len(raw) > PHASE_BYTES:
        raise ValueError("synthetic phase record byte bound")
    path = Path(probe["path"])
    fd, temporary = tempfile.mkstemp(prefix="phase-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        # Atomic publication without replacement, including an existing symlink.
        os.link(temporary, path)
    finally:
        os.unlink(temporary)
    end = time.monotonic() + probe["hold_ms"] / 1000
    while time.monotonic() < end:
        remaining = min(end - time.monotonic(), (job["deadline_unix_ms"] - time.time()*1000) / 1000)
        if remaining <= 0:
            raise ValueError("synthetic phase hold reached signed deadline")
        time.sleep(min(remaining, .01))


def network_operation(request):
    operation = request["operation"]
    if operation == "network-genesis":
        if request.get("phase_probe") is not None: raise ValueError("synthetic phase diagnostic requires proposal")
        m = model(request["recipe"]); packed = pack(m.state_dict())
        return {"checkpoint":packed,"checkpoint_hash":digest(packed),"fixture_hash":fixture_hash(),
                "model_config_hash":digest(request["recipe"]["config"]),"training_recipe_hash":digest(request["recipe"]),"metrics":metrics(m)}
    job, recipe = network_job(request)
    probe = phase_probe(request, job)
    m = network_parent(recipe, request["parent"], job["current_parent_checkpoint_hash"])
    canon = copy.deepcopy(m.state_dict())
    if operation == "network-measure":
        return {"checkpoint_hash":digest(request["parent"]),"metrics":metrics(m)}
    if operation == "network-propose":
        optimizer = torch.optim.AdamW(m.parameters(), lr=recipe["learning_rate"])
        ids, targets = fixture("train"); losses=[]
        for step in range(1, recipe["steps"] + 1):
            optimizer.zero_grad(set_to_none=True); loss=m(ids,targets)
            if not torch.isfinite(loss):raise ValueError("nonfinite real train loss")
            loss.backward();torch.nn.utils.clip_grad_norm_(m.parameters(),1.0);optimizer.step();losses.append(float(loss.detach()))
            if step == 1: record_training_phase(probe, request, job, step)
        delta=pack({n:t-canon[n] for n,t in m.state_dict().items()})
        return {"delta":delta,"parameter_delta_hash":raw_delta_hash(delta),"issued_job_hash":hashlib.sha256(request["signed_job"].encode("ascii")).hexdigest(),"train_before":losses[0],"train_after":losses[-1]}
    if operation != "network-evaluate":raise ValueError("unknown network operation")
    candidate=request["candidate"]
    if candidate["issued_job_hash"]!=hashlib.sha256(request["signed_job"].encode("ascii")).hexdigest() or candidate["parameter_delta_hash"]!=raw_delta_hash(candidate["delta"]):raise ValueError("candidate job/delta binding")
    delta,norm=unpack(candidate["delta"],canon,recipe["max_delta_norm"])
    candidate_model=copy.deepcopy(m);applied=False
    def apply_once(step):
        nonlocal applied
        if applied or step!=1:raise ValueError("network delta applied twice")
        applied=True;candidate_model.load_state_dict({n:t+delta[n] for n,t in canon.items()},strict=True)
        ids,targets=fixture("train")
        with torch.no_grad():return candidate_model(ids,targets)
    try:
        result=consolidate(candidate_model,train_step=apply_once,validate=lambda:metrics(candidate_model),policy=SleepPolicy(max_steps=1,eval_every=1,min_improvement=recipe["min_improvement"],max_anchor_accuracy_drop=0))
        accepted,before,cand,active=annotate_promotion(result,m,candidate_model)
        checkpoint=pack(candidate_model.state_dict())
        return {"accepted":accepted,"before":before,"candidate":cand,"active":active,"checkpoint":checkpoint,"checkpoint_hash":digest(checkpoint),"delta_norm":norm}
    finally:m.load_state_dict(canon,strict=True)


def network_serve():
    evaluator_key = None
    pinned = None
    seen = set()
    limit=options.network_max_requests
    if not 1<=limit<=16:raise ValueError("network child command bound")
    for count in range(limit):
        line=sys.stdin.buffer.readline((256<<10)+2)
        if not line:return
        if len(line)>(256<<10)+1 or not line.endswith(b"\n"):raise ValueError("bounded network child frame")
        request=strict_json(line)
        if request.get("operation")=="stop":return
        started=time.perf_counter()
        try:
            if request.get("operation") == "network-initialize":
                if request.get("phase_probe") is not None: raise ValueError("synthetic phase diagnostic requires proposal")
                pinned = request["pins"]
                if request.get("evaluator_private"):
                    evaluator_key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(request["evaluator_private"])[:32])
                result={"initialized":True}
            else:
                if request.get("operation") != "network-genesis":
                    if pinned is None or request["pins"] != pinned:raise ValueError("changed operator pins")
                    job,_=network_job(request)
                    identity=(request["operation"],job["session_id"],job["round_id"],job["nonce"])
                    if identity in seen:raise ValueError("worker round/nonce replay")
                    seen.add(identity)
                result=network_operation(request)
                if request.get("operation") == "network-evaluate":
                    if evaluator_key is None:raise ValueError("evaluator authority absent")
                    receipt={"protocol_version":2,"issuer_id":job["issuer_id"],"evaluator_id":job["evaluator_id"],"session_id":job["session_id"],"round_id":job["round_id"],"round_sequence":job["round_sequence"],"issued_job_hash":hashlib.sha256(request["signed_job"].encode("ascii")).hexdigest(),"current_parent_checkpoint_hash":job["current_parent_checkpoint_hash"],"candidate_checkpoint_hash":result["checkpoint_hash"],"parameter_delta_hash":request["candidate"]["parameter_delta_hash"],"accepted":result["accepted"],"before":result["before"],"candidate":result["candidate"],"active":result["active"]}
                    for field in ("training_recipe_hash","model_config_hash","genesis_checkpoint_hash","lineage_hash","consent_epoch","lease_fence","nonce","deadline_unix_ms"):
                        receipt[field]=job[field]
                    for field in ("before","candidate","active"):
                        receipt[field+"_metrics_json"]=canonical(receipt.pop(field)).decode("ascii")
                    raw=canonical(receipt);result["signed_receipt_json"]=raw.decode("ascii");result["receipt_signature"]=evaluator_key.sign(raw).hex()
            result.update(pid=os.getpid(),elapsed_seconds=time.perf_counter()-started)
        except Exception as exc:result={"error":type(exc).__name__+": "+str(exc),"pid":os.getpid()}
        frame=canonical(result)
        if len(frame)>256<<10:raise ValueError("network output cap")
        sys.stdout.buffer.write(frame+b"\n");sys.stdout.buffer.flush()


def evaluate(candidate):
    recipe = candidate["recipe"]
    m = model(recipe)
    canon = copy.deepcopy(m.state_dict())
    if candidate["recipe_hash"] != digest(recipe) or candidate["fixture_hash"] != fixture_hash():
        raise ValueError("fixture/recipe mismatch")
    if candidate["base_hash"] != digest(pack(canon)):
        raise ValueError("stale base")
    if candidate["parameter_delta_hash"] != digest(candidate["delta"]):
        raise ValueError("delta hash mismatch")
    delta, norm = unpack(candidate["delta"], canon, recipe["max_delta_norm"])
    candidate_model = copy.deepcopy(m)
    applied = False

    def apply_once(step):
        nonlocal applied
        if applied or step != 1:
            raise ValueError("delta must be applied once")
        applied = True
        candidate_model.load_state_dict({n: t + delta[n] for n, t in canon.items()}, strict=True)
        ids, targets = fixture("train")
        with torch.no_grad():
            return candidate_model(ids, targets)

    try:
        result = consolidate(candidate_model, train_step=apply_once,
                             validate=lambda: metrics(candidate_model),
                             policy=SleepPolicy(max_steps=1, eval_every=1,
                                                min_improvement=recipe["min_improvement"],
                                                max_anchor_accuracy_drop=0))
        accepted, before, cand, active = annotate_promotion(result, m, candidate_model)
        checkpoint = pack(candidate_model.state_dict()) if accepted else None
        return {"accepted": accepted, "before": before,
                "candidate": cand, "active": active,
                "checkpoint": checkpoint, "checkpoint_hash": digest(checkpoint) if checkpoint else "",
                "delta_norm": norm}
    finally:
        m.load_state_dict(canon, strict=True)


def serve():
    line = sys.stdin.buffer.readline(FRAME_BYTES + 2)
    if len(line) > FRAME_BYTES + 1 or not line.endswith(b"\n"):
        raise ValueError("oversize/unterminated frame")
    request = strict_json(line)
    started = time.perf_counter()
    if request["operation"] == "prepare-evaluator":
        # Compute identities from the OS-issued recipe before a candidate exists.
        issued = request["recipe"]
        initial = model(issued)
        identities = {"protocol_version": 1, "expert_id": "synthetic-imc",
                      "model_config_hash": digest(issued["config"]),
                      "genesis_checkpoint_hash": digest(pack(initial.state_dict())),
                      "curriculum_manifest_hash": fixture_hash(), "training_recipe_hash": digest(issued)}
        sys.stdout.buffer.write(canonical(identities) + b"\n"); sys.stdout.buffer.flush()
        dispatch = sys.stdin.buffer.readline(FRAME_BYTES + 2)
        if len(dispatch) > FRAME_BYTES + 1 or not dispatch.endswith(b"\n"):
            raise ValueError("evaluation dispatch frame")
        request = strict_json(dispatch)
        if request["operation"] != "signed-evaluate" or any(request["binding"].get(k) != v for k, v in identities.items()):
            raise ValueError("changed issued evaluator authorization")
    if request["operation"] == "propose":
        result = propose(request["recipe"])
    elif request["operation"] == "signed-propose":
        private = Ed25519PrivateKey.generate()
        public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        # Public key is registered on the dedicated own pipe before candidate dispatch.
        sys.stdout.buffer.write(canonical({"public_key": public.hex(), "pid": os.getpid()}) + b"\n")
        sys.stdout.buffer.flush()
        dispatch = sys.stdin.buffer.readline(FRAME_BYTES + 2)
        if len(dispatch) > FRAME_BYTES + 1 or not dispatch.endswith(b"\n"):
            raise ValueError("dispatch frame")
        dispatch = strict_json(dispatch)
        candidate = propose(request["recipe"])
        result = {"envelope": signed_candidate(candidate, dispatch["binding"], private),
                  "train_loss_before": candidate["train_loss_before"], "train_loss_after": candidate["train_loss_after"]}
    elif request["operation"] == "signed-evaluate":
        candidate = verify_candidate(request["envelope"], bytes.fromhex(request["public_key"]), request["binding"])
        result = evaluate(candidate)
        result["baseline_checkpoint"] = pack(model(candidate["recipe"]).state_dict())
    elif request["operation"] == "evaluate":
        result = evaluate(request["candidate"])
    else:
        raise ValueError("unknown operation")
    result["pid"] = os.getpid()
    result["elapsed_seconds"] = time.perf_counter() - started
    frame = canonical(result)
    if len(frame) > FRAME_BYTES:
        raise ValueError("output exceeds frame limit")
    sys.stdout.buffer.write(frame + b"\n")
    sys.stdout.buffer.flush()
    if request["operation"] == "signed-evaluate":
        followup = sys.stdin.buffer.readline(FRAME_BYTES + 2)
        if len(followup) > FRAME_BYTES + 1 or not followup.endswith(b"\n"):
            raise ValueError("checkpoint measurement frame")
        followup = strict_json(followup)
        if followup["operation"] != "measure-checkpoints" or set(followup["checkpoints"]) != {"active", "rollback"}:
            raise ValueError("checkpoint measurement operation")
        measured = {}
        for name, packed in followup["checkpoints"].items():
            m = model(candidate["recipe"])
            state, _ = unpack(packed, m.state_dict(), 100)
            m.load_state_dict(state, strict=True)
            measured[name] = metrics(m)
        sys.stdout.buffer.write(canonical(measured) + b"\n")
        sys.stdout.buffer.flush()


if __name__ == "__main__":
    try:
        if options.network_loop:network_serve()
        else:serve()
    except Exception as exc:
        print(type(exc).__name__ + ": " + str(exc), file=sys.stderr)
        raise SystemExit(1)
