"""Public synthetic only; tests execute the canonical IMC, never checkpoints."""
import importlib.util
import json
from pathlib import Path
import time
import pytest

spec = importlib.util.spec_from_file_location("mobile_imc_provider", Path(__file__).with_name("provider.py"))
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)


def request(**updates):
    value = dict(protocol_version=1, task_id="test.1", parent_task_id="", initiator="fixture-user",
                 language="ro", modality="text", goal="public canary", privacy_class="LOCAL_PRIVATE",
                 domain_signature="general", evidence_refs=[], hippocampus_refs=[], working_memory_summary="",
                 tool_observations=[], constraints=["no_training", "no_tools"],
                 desired_output_schema="CorticalResponse", deadline_unix_ms=int(time.time()*1000)+30000,
                 compute_budget=3, confidence_requirement=0, requested_role="inference")
    value.update(updates)
    return value


@pytest.mark.parametrize("raw", [b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":1.0}', b'{"a":1e0}',
                                b'{"a":9007199254740992}', b'{"a":"\\ud800"}', b'{"a":"\\udc00"}',
                                b'\xff', b'{}{}', b'['*18+b'0'+b']'*18, b' '*65537], ids=lambda raw: str(len(raw))+'bytes')
def test_strict_rejects(raw):
    with pytest.raises((ValueError, UnicodeError)):
        provider.strict_json(raw)


@pytest.mark.parametrize("update", [dict(protocol_version=2), dict(compute_budget=17),
                                   dict(compute_budget=True), dict(privacy_class="SENSITIVE"),
                                   dict(requested_role="training"), dict(modality="image"),
                                   dict(constraints=[]), dict(tool_observations=["execute"]),
                                   dict(deadline_unix_ms=0), dict(evidence_refs=None),
                                   dict(extra="unknown"), dict(goal="x"*4097), dict(language="x"*4097),
                                   dict(initiator="user\n"), dict(desired_output_schema="Other"),
                                   dict(domain_signature="training")])
def test_contract_refusals(update):
    with pytest.raises(ValueError):
        provider.validate_request(request(**update))


def test_required_fields_match_current_canonical_manifest():
    assert set(request()) == set(provider.fields("CorticalRequest"))
    for field in request():
        value = request()
        del value[field]
        with pytest.raises(ValueError):
            provider.validate_request(value)


def test_real_imc_canary_is_reproducible_and_uses_forward(monkeypatch):
    model = provider.canary_provider()
    actual = model.model.forward
    calls = []
    def traced(*args, **kw):
        calls.append(True)
        return actual(*args, **kw)
    monkeypatch.setattr(model.model, "forward", traced)
    response = model.infer(request())
    assert calls and len(calls) == response["compute_cost"]
    assert response["runtime_metrics"]["canary"] == "true"
    assert int(response["runtime_metrics"]["forward_passes"]) == len(calls)
    assert response["runtime_metrics"]["model_hash"] == provider.canary_provider().model_hash
    assert response["hypothesis"].startswith("[TEST IMC canary")
    assert response["runtime_metrics"]["training"] == "unavailable"
    assert response["proposed_swyp_plan"] == ""
    provider.validate_record("CorticalResponse", response)


def test_cancel_before_forward_does_not_compute(monkeypatch):
    model = provider.canary_provider()
    monkeypatch.setattr(model.model, "forward", lambda *_: pytest.fail("cancelled model ran"))
    with pytest.raises(TimeoutError):
        model.infer(request(), lambda: True)



def test_provenance_cannot_claim_different_owned_weights():
    legitimate = provider.canary_provider()
    with pytest.raises(ValueError, match="provenance mismatch"):
        provider.IMCProvider(legitimate.model, legitimate.encode, legitimate.decode,
                            model_hash="a"*64, tokenizer_hash=legitimate.tokenizer_hash)
def test_production_adapter_rejects_other_architecture():
    with pytest.raises(ValueError, match="canonical IMC"):
        provider.IMCProvider(object(), str, str, model_hash="a"*64, tokenizer_hash="b"*64)
