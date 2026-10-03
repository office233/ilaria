import copy
import importlib.util
from pathlib import Path

import pytest
import time
import json
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

spec = importlib.util.spec_from_file_location("local_imc_peer", Path(__file__).with_name("peer.py"))
peer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(peer)


def test_disjoint_fixture_and_actual_loss():
    sets = [set(tuple(row) for row in peer.fixture(s)[0].tolist()) for s in ("train", "eval", "anchors")]
    assert not sets[0] & sets[1] and not sets[0] & sets[2] and not sets[1] & sets[2]
    c = peer.propose(copy.deepcopy(peer.RECIPE))
    assert c["train_loss_after"] < c["train_loss_before"]
    result = peer.evaluate(c)
    assert result["before"]["objective"] > 0
    assert isinstance(result["accepted"], bool)


@pytest.mark.parametrize("fault", ["shape", "dtype", "length", "nan", "inf", "names"])
def test_reject_delta_before_mutation(fault):
    m = peer.model(peer.RECIPE)
    state = m.state_dict()
    zero = {n: t * 0 for n, t in state.items()}
    payload = peer.pack(zero)
    n = next(iter(payload))
    if fault == "shape": payload[n]["shape"] = [1]
    if fault == "dtype": payload[n]["dtype"] = "float64"
    if fault == "length": payload[n]["data"] += "AAAA"
    if fault == "names": payload["unknown"] = payload[n]
    if fault in ("nan", "inf"):
        zero[n].reshape(-1)[0] = float(fault)
        payload = peer.pack(zero)
    with pytest.raises(ValueError): peer.unpack(payload, state, 20)
    assert peer.digest(peer.pack(m.state_dict())) == peer.digest(peer.pack(state))


def test_zero_delta_regression_restores():
    c = peer.propose(copy.deepcopy(peer.RECIPE))
    m = peer.model(peer.RECIPE)
    c["delta"] = peer.pack({n: t * 0 for n, t in m.state_dict().items()})
    c["parameter_delta_hash"] = peer.digest(c["delta"])
    result = peer.evaluate(c)
    assert not result["accepted"] and result["checkpoint"] is None
    assert result["before"] == result["active"]


def test_stale_fixture_recipe_and_bounds():
    c = peer.propose(copy.deepcopy(peer.RECIPE))
    c["base_hash"] = "stale"
    with pytest.raises(ValueError, match="stale"): peer.evaluate(c)
    r = copy.deepcopy(peer.RECIPE); r["steps"] = 65
    with pytest.raises(ValueError): peer.model(r)


def test_ed25519_origin_metadata_raw_delta_and_duplicate_keys():
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    binding = {"peer_id": "peer-a", "round_id": "r1", "nonce": "a" * 64,
               "consent_epoch": 1, "lease_fence": 3, "deadline_unix_ms": int(time.time()*1000)+60000,
               "signer_key_id": peer.hashlib.sha256(public).hexdigest()}
    c = peer.propose(copy.deepcopy(peer.RECIPE))
    binding.update(protocol_version=1, expert_id="synthetic-imc", model_config_hash=peer.digest(c["recipe"]["config"]),
                   genesis_checkpoint_hash=c["base_hash"], curriculum_manifest_hash=c["fixture_hash"], training_recipe_hash=c["recipe_hash"])
    envelope = peer.signed_candidate(c, binding, private)
    verified = peer.verify_candidate(envelope, public, binding)
    assert verified["delta"] == c["delta"]
    bad = dict(envelope); bad["unknown"] = 1
    with pytest.raises(ValueError, match="unknown"):
        peer.verify_candidate(bad, public, binding)
    bad = dict(envelope); bad["signature"] = "00" * 64
    with pytest.raises(Exception): peer.verify_candidate(bad, public, binding)
    for field in ("peer_id", "nonce", "consent_epoch", "payload_base64", "tensor_layout_json"):
        bad = dict(envelope); bad[field] = "tampered"
        with pytest.raises(Exception): peer.verify_candidate(bad, public, binding)
    stale = dict(binding); stale["lease_fence"] += 1
    with pytest.raises(ValueError): peer.verify_candidate(envelope, public, stale)
    with pytest.raises(ValueError, match="duplicate"):
        peer.strict_json(b'{"nonce":"a","nonce":"b"}')


def test_norm_budget_and_oversize_auth_before_model_allocation():
    m = peer.model(peer.RECIPE)
    state = m.state_dict()
    large = peer.pack({n: t * 0 + 100 for n, t in state.items()})
    with pytest.raises(ValueError, match="norm"):
        peer.unpack(large, state, 20)
    with pytest.raises(ValueError, match="oversize"):
        peer.verify_candidate({"payload_base64": "A" * peer.FRAME_BYTES}, b"", {})


def test_candidate_exception_never_mutates_canonical(monkeypatch):
    c = peer.propose(copy.deepcopy(peer.RECIPE))
    canonical_model = peer.model(peer.RECIPE)
    before = peer.digest(peer.pack(canonical_model.state_dict()))
    monkeypatch.setattr(peer, "model", lambda recipe: canonical_model)
    calls = 0
    original = peer.metrics
    def fail_on_candidate(m):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("synthetic evaluator crash")
        return original(m)
    monkeypatch.setattr(peer, "metrics", fail_on_candidate)
    with pytest.raises(RuntimeError, match="crash"):
        peer.evaluate(c)
    assert peer.digest(peer.pack(canonical_model.state_dict())) == before


def test_review_resigned_policy_requires_complete_issued_authorization():
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    binding = {"peer_id": "peer-a", "round_id": "review-round", "nonce": "b" * 64,
               "consent_epoch": 1, "lease_fence": 3, "deadline_unix_ms": int(time.time()*1000)+60000,
               "signer_key_id": peer.hashlib.sha256(public).hexdigest()}
    legitimate = peer.propose(copy.deepcopy(peer.RECIPE))
    changed = copy.deepcopy(legitimate)
    changed["recipe"].update(learning_rate=0.02, max_delta_norm=2000, min_improvement=1e-12)
    changed["recipe_hash"] = peer.digest(changed["recipe"])
    envelope = peer.signed_candidate(changed, binding, private)
    # The reviewed incomplete OS issuance must fail even though the re-signature
    # is legitimate and every received hash is internally consistent.
    rejected = False
    try:
        verified = peer.verify_candidate(envelope, public, binding)
    except ValueError:
        rejected = True
    if not rejected:
        verdict = peer.evaluate(verified)
        print("REVIEW_RED valid_resign_accepted=", verdict["accepted"],
              "issued_recipe_hash=", peer.digest(legitimate["recipe"]),
              "received_recipe_hash=", changed["recipe_hash"])
    assert rejected, "valid peer signature authorized changed policy under incomplete issuance"


@pytest.mark.parametrize("policy", ["learning_rate", "max_delta_norm", "min_improvement", "steps"])
def test_review_valid_resign_changed_policy_rejected_before_allocation(policy, monkeypatch, tmp_path):
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    legitimate = peer.propose(copy.deepcopy(peer.RECIPE))
    binding = {"protocol_version": 1, "expert_id": "synthetic-imc", "peer_id": "peer-a", "round_id": "r1",
               "nonce": "c" * 64, "consent_epoch": 1, "lease_fence": 1, "deadline_unix_ms": int(time.time()*1000)+60000,
               "signer_key_id": peer.hashlib.sha256(public).hexdigest(), "model_config_hash": peer.digest(legitimate["recipe"]["config"]),
               "genesis_checkpoint_hash": legitimate["base_hash"], "curriculum_manifest_hash": legitimate["fixture_hash"],
               "training_recipe_hash": legitimate["recipe_hash"]}
    valid = peer.signed_candidate(legitimate, binding, private)
    assert peer.verify_candidate(valid, public, binding)["recipe"] == legitimate["recipe"]
    changed = copy.deepcopy(legitimate)
    changed["recipe"][policy] = {"learning_rate": 0.02, "max_delta_norm": 2000, "min_improvement": 1e-12, "steps": 17}[policy]
    changed["recipe_hash"] = peer.digest(changed["recipe"])
    envelope = peer.signed_candidate(changed, binding, private)
    active = tmp_path / "active.json"; active.write_text("prior-active-hash")
    before = peer.hashlib.sha256(active.read_bytes()).hexdigest()
    monkeypatch.setattr(peer, "model", lambda _: pytest.fail("candidate allocated before issued-contract rejection"))
    with pytest.raises(ValueError, match="binding"):
        peer.verify_candidate(envelope, public, binding)
    for field in binding:
        incomplete = dict(binding); del incomplete[field]
        with pytest.raises(ValueError, match="incomplete"):
            peer.verify_candidate(valid, public, incomplete)
        bad = dict(valid); bad["signed_canonical_base64"] = ""; bad["signature"] = ""
        bad[field] = (bad[field] + 1) if type(bad[field]) is int else "different"
        unsigned = peer.canonical(bad)
        bad["signed_canonical_base64"] = peer.base64.b64encode(unsigned).decode("ascii")
        bad["signature"] = private.sign(unsigned).hex()
        with pytest.raises(ValueError): peer.verify_candidate(bad, public, binding)
    assert peer.hashlib.sha256(active.read_bytes()).hexdigest() == before


@pytest.mark.parametrize("steps", [1, 9, 64])
def test_review_variable_steps_authorized_exactly(steps):
    recipe = copy.deepcopy(peer.RECIPE); recipe["steps"] = steps
    initial = peer.model(recipe)
    candidate = {"recipe": recipe, "recipe_hash": peer.digest(recipe), "base_hash": peer.digest(peer.pack(initial.state_dict())),
                 "fixture_hash": peer.fixture_hash(), "delta": peer.pack({n: t * 0 for n,t in initial.state_dict().items()})}
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    binding = {"protocol_version":1,"expert_id":"synthetic-imc","peer_id":"peer-a","round_id":"variable",
               "model_config_hash":peer.digest(recipe["config"]),"genesis_checkpoint_hash":candidate["base_hash"],
               "curriculum_manifest_hash":candidate["fixture_hash"],"training_recipe_hash":candidate["recipe_hash"],
               "consent_epoch":1,"lease_fence":1,"nonce":"d"*64,"deadline_unix_ms":int(time.time()*1000)+60000,
               "signer_key_id":peer.hashlib.sha256(public).hexdigest()}
    envelope = peer.signed_candidate(candidate,binding,private)
    assert peer.verify_candidate(envelope,public,binding)["recipe"]["steps"] == steps


def test_network_current_parent_successive_rounds_and_reject():
    recipe=copy.deepcopy(peer.RECIPE);recipe.update(learning_rate=0.001,steps=4)
    genesis=peer.network_operation({"operation":"network-genesis","recipe":recipe})
    issuer=Ed25519PrivateKey.generate();proposer=Ed25519PrivateKey.generate();evaluator=Ed25519PrivateKey.generate()
    keys={name:key.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw).hex() for name,key in (("issuer",issuer),("proposer",proposer),("evaluator",evaluator))}
    pins={name+suffix:value for name in keys for suffix,value in (("_id",name),("_key",keys[name]))}
    parent=genesis["checkpoint"];parent_hash=genesis["checkpoint_hash"]
    for sequence in (1,2):
        job={"protocol_version":2,"issuer_id":"issuer","expert_id":"synthetic-imc","lineage_hash":parent_hash,"proposer_id":"proposer","evaluator_id":"evaluator","proposer_key_hash":peer.hashlib.sha256(bytes.fromhex(keys["proposer"])).hexdigest(),"evaluator_key_hash":peer.hashlib.sha256(bytes.fromhex(keys["evaluator"])).hexdigest(),"dataset_scope":"synthetic-public-v1","authorized_purpose":"local-network-training","consent_epoch":1,"lease_fence":1,"deadline_unix_ms":int(time.time()*1000)+60000,"recipe_json":peer.canonical(recipe).decode(),"training_recipe_hash":peer.digest(recipe),"model_config_hash":peer.digest(recipe["config"]),"curriculum_manifest_hash":peer.fixture_hash(),"current_parent_checkpoint_hash":parent_hash,"genesis_checkpoint_hash":genesis["checkpoint_hash"],"round_id":str(sequence),"nonce":str(sequence),"session_id":"synthetic","round_sequence":sequence}
        signed=peer.canonical(job);request={"operation":"network-propose","signed_job":signed.decode(),"signature":issuer.sign(signed).hex(),"pins":pins,"parent":parent}
        proposed=peer.network_operation(request)
        request.update(operation="network-evaluate",candidate=proposed)
        result=peer.network_operation(request);assert result["accepted"]
        assert result["before"]["objective"]>result["active"]["objective"]
        parent=result["checkpoint"];parent_hash=result["checkpoint_hash"]
        bad=dict(request);bad["parent"]=genesis["checkpoint"]
        if sequence==2:
            with pytest.raises(ValueError,match="parent"):peer.network_operation(bad)
        modified=dict(job);modified["authorized_purpose"]="private-data-training"
        changed=peer.canonical(modified);bad=dict(request);bad.update(signed_job=changed.decode(),signature=issuer.sign(changed).hex())
        with pytest.raises(ValueError,match="scope/purpose"):peer.network_operation(bad)
        bad=dict(request);bad["signature"]=proposer.sign(signed).hex()
        with pytest.raises(Exception):peer.network_operation(bad)
