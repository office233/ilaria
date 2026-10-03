"""IMC (Ilaria MicroCortex) model: GQA, RMSNorm, bias-free, optional ternary."""
import math
import os
import sys
import tempfile

import pytest
import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from imc_model import PRESETS, ImcConfig, ImcTransformer, load_imc, save_imc  # noqa: E402
from data_contract import TOKEN_STREAM_FORMAT, sha256_file  # noqa: E402


def tiny(**kw) -> ImcTransformer:
    torch.manual_seed(0)
    cfg = ImcConfig(vocab_size=64, d_model=32, n_layers=2, n_heads=4, n_kv_heads=2, ffn_dim=48,
                    eos_token_id=3, max_seq_len=16, **kw)
    return ImcTransformer(cfg)


@pytest.mark.parametrize("name,target", [("imc-125m", 125e6), ("imc-250m", 250e6),
                                         ("imc-500m", 500e6), ("imc-1b", 1_000_555_520)])
def test_presets_hit_their_size_with_a_65536_vocab(name, target):
    cfg = ImcConfig.preset(name, vocab_size=65536, eos_token_id=61_440, max_seq_len=16)
    assert abs(cfg.param_count() - target) / target < 0.03, cfg.param_count()


def test_imc_1b_matches_the_spec():
    cfg = PRESETS["imc-1b"]
    assert (cfg["d_model"], cfg["n_layers"], cfg["n_heads"], cfg["n_kv_heads"], cfg["ffn_dim"]) == (2048, 16, 16, 4, 7104)


@pytest.mark.parametrize("field,value", [
    ("vocab_size", 0), ("d_model", -32), ("n_layers", 0),
    ("n_heads", 0), ("n_kv_heads", 0), ("ffn_dim", -1),
    ("max_seq_len", 0), ("n_layers", True), ("eos_token_id", -1),
    ("eos_token_id", 64), ("rope_theta", float("nan")),
    ("norm_eps", float("inf")), ("norm_eps", 0),
])
def test_config_rejects_invalid_dimensions_and_numerical_contract(field, value):
    config = tiny().cfg.to_json()
    config[field] = value
    with pytest.raises(ValueError, match=field):
        ImcConfig.from_json(config)


def test_param_count_formula_matches_the_module():
    model = tiny()
    assert model.cfg.param_count() == sum(p.numel() for p in model.parameters())


@pytest.mark.parametrize("dtype", [torch.float16, torch.bfloat16])
def test_rmsnorm_mixed_precision_keeps_fp32_master_weight(dtype):
    from imc_model import RMSNorm

    norm = RMSNorm(32, 1e-5)
    x = torch.randn(2, 5, 32, dtype=dtype, requires_grad=True)
    out = norm(x)
    assert out.dtype == dtype
    assert norm.weight.dtype == torch.float32
    out.float().square().mean().backward()
    assert norm.weight.grad is not None
    assert norm.weight.grad.dtype == torch.float32
    assert torch.isfinite(norm.weight.grad).all()


def test_grouped_query_attention_shapes_and_no_biases():
    model = tiny()
    attn = model.blocks[0].attn
    assert tuple(attn.WQ.shape) == (32, 32)
    assert tuple(attn.WK.shape) == (32, 16) and tuple(attn.WV.shape) == (32, 16)
    assert not any("B" == n.split(".")[-1][0] for n, _ in model.named_parameters())


def test_forward_is_causal():
    model = tiny().eval()
    a = torch.randint(0, 64, (1, 10))
    b = a.clone()
    b[0, 7:] = (b[0, 7:] + 1) % 64
    with torch.no_grad():
        la, lb = model(a), model(b)
    assert la.shape == (1, 10, 64)
    assert torch.allclose(la[0, :7], lb[0, :7], atol=1e-5)
    assert not torch.allclose(la[0, 7:], lb[0, 7:])


@pytest.mark.parametrize("ternary", [False, True])
def test_learns_a_pattern(ternary):
    model = tiny(ternary=ternary)
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3)
    seq = torch.tensor([[2, 3, 4, 5, 6, 7, 8, 9, 10, 11]] * 4)
    x, y = seq[:, :-1], seq[:, 1:]
    first = None
    for _ in range(150):
        loss = F.cross_entropy(model(x).reshape(-1, 64), y.reshape(-1))
        first = first if first is not None else loss.item()
        opt.zero_grad()
        loss.backward()
        opt.step()
    assert loss.item() < first * 0.2, (first, loss.item())


@pytest.mark.parametrize("ternary", [False, True])
def test_save_and_load_give_identical_logits(ternary):
    model = tiny(ternary=ternary).eval()
    ids = torch.randint(0, 64, (2, 9))
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "imc.pt")
        save_imc(model, path)
        loaded = load_imc(path).eval()
    assert loaded.cfg == model.cfg
    with torch.no_grad():
        assert torch.equal(model(ids), loaded(ids))


def test_ternary_changes_the_function_and_config_round_trips():
    full, tern = tiny(), tiny(ternary=True)
    tern.load_state_dict(full.state_dict())
    ids = torch.randint(0, 64, (1, 8))
    assert not torch.allclose(full(ids), tern(ids))
    assert ImcConfig.from_json(tern.cfg.to_json()) == tern.cfg


def test_generate_greedy_stops_at_eos():
    model = tiny()
    out = model.generate_greedy([1, 2, 3], 5)
    assert out[:3] == [1, 2, 3] and 3 < len(out) <= 8


def test_target_token_budget_resolves_global_step_horizon():
    from train_ilaria import steps_for_target_tokens

    assert steps_for_target_tokens(
        1_000_000_000,
        ctx=2048,
        batch=4,
        accum=32,
        world=1,
    ) == 3815
    assert steps_for_target_tokens(
        1_000_000_000,
        ctx=2048,
        batch=4,
        accum=32,
        world=4,
    ) == 954


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({}, (1, 0, 0)),
        ({"WORLD_SIZE": "4", "RANK": "3", "LOCAL_RANK": "1"}, (4, 3, 1)),
    ],
)
def test_distributed_env_validates_rank_contract(env, expected):
    from train_ilaria import distributed_env

    assert distributed_env(env) == expected


@pytest.mark.parametrize(
    "env",
    [
        {"WORLD_SIZE": "0"},
        {"WORLD_SIZE": "1", "RANK": "1"},
        {"LOCAL_RANK": "-1"},
        {"WORLD_SIZE": "not-an-int"},
    ],
)
def test_distributed_env_rejects_invalid_values(env):
    from train_ilaria import distributed_env

    with pytest.raises(ValueError):
        distributed_env(env)


def test_trainer_runs_resumes_and_exports_ternary_imc(tmp_path):
    import json as _json
    import subprocess

    prefix = _tiny_stream(tmp_path, "train", seed=0)
    val_prefix = _tiny_stream(tmp_path, "validation", seed=1)
    out = tmp_path / "run"
    trainer = os.path.join(os.path.dirname(os.path.abspath(__file__)), "train_ilaria.py")
    base = [sys.executable, trainer, "--data", str(prefix), "--val-data", str(val_prefix), "--out", str(out), "--allow-unmanifested-data", "--ternary",
            "--embed-dim", "32", "--heads", "4", "--kv-heads", "2", "--layers", "2", "--ffn-dim", "48",
            "--ctx", "16", "--max-seq-len", "16", "--batch", "4", "--steps", "40", "--warmup", "4",
            "--lr", "3e-3", "--min-lr", "3e-4", "--eval-every", "20", "--eval-iters", "2", "--precision", "fp32"]
    first = subprocess.run(base + ["--stop-after", "20"], capture_output=True, text=True, timeout=600)
    assert first.returncode == 0, first.stderr[-2000:]
    second = subprocess.run(base + ["--resume", str(out / "checkpoint.pt")], capture_output=True, text=True, timeout=600)
    assert second.returncode == 0, second.stderr[-2000:]
    assert "resumed from" in second.stdout and "DONE" in second.stdout
    model = load_imc(str(out / "imc.pt"))
    assert model.cfg.ternary and model.cfg.n_kv_heads == 2
    log = [_json.loads(line) for line in (out / "training.log").read_text().splitlines()]
    assert log[-1]["val_loss"] < math.log(40) - 0.5, log  # clearly better than uniform guessing


@pytest.mark.parametrize("ternary", [False, True])
def test_chunked_loss_equals_full_cross_entropy_with_same_gradients(ternary):
    model = tiny(ternary=ternary)
    x = torch.randint(0, 64, (3, 11))
    y = torch.randint(0, 64, (3, 11))
    full = F.cross_entropy(model(x).reshape(-1, 64), y.reshape(-1))
    full.backward()
    want = {n: p.grad.clone() for n, p in model.named_parameters()}
    model.zero_grad()
    chunked = model(x, y, loss_chunk_tokens=5)   # 33 tokens -> 7 chunks, last one partial
    chunked.backward()
    assert torch.allclose(full, chunked, atol=1e-5)
    for n, p in model.named_parameters():
        assert torch.allclose(want[n], p.grad, atol=1e-5), n


@pytest.mark.parametrize("chunk_size", [-1, 0, True])
def test_chunked_loss_rejects_invalid_chunk_size(chunk_size):
    model = tiny()
    tokens = torch.ones((1, 4), dtype=torch.long)
    with pytest.raises(ValueError, match="loss_chunk_tokens"):
        model(tokens, tokens, loss_chunk_tokens=chunk_size)


def test_chunked_loss_rejects_target_shape_mismatch():
    model = tiny()
    with pytest.raises(ValueError, match="targets"):
        model(torch.ones((2, 4), dtype=torch.long), torch.ones((1, 4), dtype=torch.long))


def test_chunked_evaluation_matches_full_loss_without_requesting_dense_logits(monkeypatch):
    import numpy as np
    from train_ilaria import evaluate

    model = tiny(ternary=True)
    data = np.arange(500, dtype=np.int64) % model.cfg.vocab_size
    full = evaluate(model, data, 8, 2, "cpu", 3, np.random.default_rng(7), None)
    original_forward = model.forward

    def forward_with_targets(ids, targets=None):
        assert targets is not None, "chunked evaluation allocated dense vocabulary logits"
        return original_forward(ids, targets, loss_chunk_tokens=5)

    monkeypatch.setattr(model, "forward", forward_with_targets)
    chunked = evaluate(model, data, 8, 2, "cpu", 3, np.random.default_rng(7), None, chunked_loss=True)
    assert chunked == pytest.approx(full, abs=1e-6)
    assert model.training


def _tiny_stream(tmp_path, name="stream", seed=0):
    import json as _json

    import numpy as np
    rng = np.random.default_rng(seed)
    tokens = np.tile(np.arange(4, 36, dtype="<u2"), 400) ^ rng.integers(0, 2, 12800, dtype="<u2")
    prefix = tmp_path / name
    bin_path = str(prefix) + ".bin"
    tokens.tofile(bin_path)
    tokenizer = tmp_path / "tokenizer.json"
    if not tokenizer.exists():
        tokenizer.write_text('{"fixture":"ilarialex"}\n', encoding="utf-8")
    meta = {
        "format": TOKEN_STREAM_FORMAT,
        "dtype": "uint16",
        "vocab_size": 40,
        "eos_id": 3,
        "protocol_start_id": 36,
        "tokens": len(tokens),
        "documents": 0,
        "tokenizer": tokenizer.name,
        "tokenizer_sha256": sha256_file(tokenizer),
        "tokenizer_format": "ilarialex-v1",
        "stream_sha256": sha256_file(bin_path),
        "byte_level": True,
    }
    (tmp_path / f"{name}.json").write_text(
        _json.dumps(meta), encoding="utf-8"
    )
    return prefix


TINY_ARGS = ["--allow-unmanifested-data", "--ternary", "--embed-dim", "32", "--heads", "4", "--kv-heads", "2",
             "--layers", "2", "--ffn-dim", "48", "--ctx", "16", "--max-seq-len", "16", "--batch", "4",
             "--warmup", "4", "--lr", "3e-3", "--min-lr", "3e-4", "--eval-iters", "2", "--precision", "fp32"]


def test_two_process_ddp_with_chunked_loss_trains_and_saves_once(tmp_path):
    import json as _json
    import socket
    import subprocess
    prefix = _tiny_stream(tmp_path, "train", seed=0)
    val_prefix = _tiny_stream(tmp_path, "validation", seed=1)
    out = tmp_path / "run"
    trainer = os.path.join(os.path.dirname(os.path.abspath(__file__)), "train_ilaria.py")
    args = [trainer, "--data", str(prefix), "--val-data", str(val_prefix), "--out", str(out), "--chunked-loss", "--accum", "2",
            "--steps", "30", "--eval-every", "15"] + TINY_ARGS
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = dict(os.environ, USE_LIBUV="0", OMP_NUM_THREADS="1", MKL_NUM_THREADS="1", CUDA_VISIBLE_DEVICES="",
               WORLD_SIZE="2", MASTER_ADDR="127.0.0.1", MASTER_PORT=str(port))
    workers = [subprocess.Popen([sys.executable] + args, env=dict(env, RANK=str(r), LOCAL_RANK=str(r)),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for r in range(2)]
    try:
        outputs = [w.communicate(timeout=600) for w in workers]
    finally:
        for w in workers:
            if w.poll() is None:
                w.kill()
    for w, (so, se) in zip(workers, outputs):
        assert w.returncode == 0, se[-3000:]
    assert "DONE" in outputs[0][0] and outputs[1][0] == ""
    ck = torch.load(out / "checkpoint.pt", map_location="cpu", weights_only=True)
    assert ck["signature"]["world_size"] == 2 and ck["tokens_seen"] == 30 * 2 * 2 * 4 * 16
    log = [_json.loads(line) for line in (out / "training.log").read_text().splitlines()]
    assert len(log) == 2 and log[-1]["val_loss"] < math.log(40) - 0.5, log
    assert load_imc(str(out / "imc.pt")).cfg.ternary


def test_two_process_ddp_resume_preserves_every_rank_rng_and_exact_training(tmp_path):
    import socket
    import subprocess

    prefix = _tiny_stream(tmp_path, "train", seed=0)
    val_prefix = _tiny_stream(tmp_path, "validation", seed=1)
    trainer = os.path.join(os.path.dirname(os.path.abspath(__file__)), "train_ilaria.py")
    base = [trainer, "--data", str(prefix), "--val-data", str(val_prefix), "--chunked-loss",
            "--accum", "2", "--steps", "6", "--eval-every", "4", "--sample-tokens", "0"] + TINY_ARGS

    def run(out, extra=()):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        env = dict(os.environ, USE_LIBUV="0", OMP_NUM_THREADS="1", MKL_NUM_THREADS="1",
                   CUDA_VISIBLE_DEVICES="", WORLD_SIZE="2", MASTER_ADDR="127.0.0.1", MASTER_PORT=str(port))
        workers = [subprocess.Popen([sys.executable] + base + ["--out", str(out)] + list(extra),
                                    env=dict(env, RANK=str(r), LOCAL_RANK=str(r)),
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for r in range(2)]
        try:
            outputs = [worker.communicate(timeout=120) for worker in workers]
            for worker, (_, stderr) in zip(workers, outputs):
                assert worker.returncode == 0, stderr[-4000:]
        finally:
            for worker in workers:
                if worker.poll() is None:
                    worker.kill()
                    worker.wait()
        return torch.load(out / "checkpoint.pt", map_location="cpu", weights_only=True)

    full = run(tmp_path / "full")
    out = tmp_path / "resumed"
    paused = run(out, ["--stop-after", "3"])
    assert len(paused["rank_rng"]) == 2
    assert paused["rank_rng"][0]["numpy"] != paused["rank_rng"][1]["numpy"]
    resumed = run(out, ["--resume", str(out / "checkpoint.pt")])

    def assert_same(left, right):
        if isinstance(left, torch.Tensor):
            assert torch.equal(left, right)
        elif isinstance(left, dict):
            assert left.keys() == right.keys()
            for key in left:
                assert_same(left[key], right[key])
        elif isinstance(left, (list, tuple)):
            assert len(left) == len(right)
            for a, b in zip(left, right):
                assert_same(a, b)
        else:
            assert left == right

    assert_same(full, resumed)
    assert (tmp_path / "full" / "training.log").read_bytes() == (out / "training.log").read_bytes()

def test_trainer_rejects_training_stream_hash_mismatch(tmp_path):
    import subprocess

    prefix = _tiny_stream(tmp_path)
    with open(str(prefix) + ".bin", "ab") as stream:
        stream.write(b"\x00\x00")
    trainer = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "train_ilaria.py"
    )
    proc = subprocess.run(
        [
            sys.executable, trainer, "--data", str(prefix),
            "--out", str(tmp_path / "run"), "--allow-unmanifested-data", "--ternary",
            "--embed-dim", "32", "--heads", "4", "--kv-heads", "2",
            "--layers", "2", "--ffn-dim", "48", "--ctx", "16",
            "--max-seq-len", "16", "--batch", "4", "--steps", "1",
            "--eval-every", "1", "--eval-iters", "1",
            "--precision", "fp32",
        ],
        capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode != 0
    assert (
        "byte size" in proc.stderr
        or "hash differs" in proc.stderr
        or "byte size" in proc.stdout
        or "hash differs" in proc.stdout
    )

# Cached inference compares against the existing full-prefix implementation,
# never a second attention/model implementation.
from dataclasses import replace
import time
from imc_model import InferencePolicy, InferenceCancelled


def cache_model(seed=0, **changes):
    cfg = tiny().cfg.to_json()
    cfg.update(changes)
    torch.manual_seed(seed)
    torch.set_num_threads(1)
    return ImcTransformer(ImcConfig.from_json(cfg)).eval()


def cache_policy(model, **changes):
    values = dict(max_cache_bytes=1_000_000, max_tokens=model.cfg.max_seq_len,
                  max_batch=2, max_total_tokens=128)
    values.update(changes)
    return InferencePolicy(**values)


@pytest.mark.parametrize("ternary", [False, True])
@pytest.mark.parametrize("ffn_act", ["silu", "relu2"])
@pytest.mark.parametrize("subln", [False, True])
@pytest.mark.parametrize("n_kv_heads", [1, 2, 4])
@pytest.mark.parametrize("seed", [0, 19])
@pytest.mark.parametrize("batch", [1, 2])
def test_cache_full_prefix_logits_chunks_batch_and_repeated_rollover(ternary, ffn_act, subln, n_kv_heads, seed, batch):
    model = cache_model(seed, ternary=ternary, ffn_act=ffn_act, subln=subln, n_kv_heads=n_kv_heads)
    policy = cache_policy(model)
    ids = (torch.arange(batch * 23).reshape(batch, 23) * 7 + seed) % 64
    state, consumed = None, 0
    for count in [3, 2, 1, 4, 8, 1, 1, 1]:
        previous = state
        chunk = ids[:, consumed:consumed+count]
        consumed += count
        logits, state = model.inference_step(chunk, policy=policy, stream_id="batch", weights_epoch=4, state=state)
        with torch.no_grad():
            oracle = model(ids[:, :consumed][:, -16:])[:, -1]
            torch.testing.assert_close(logits, oracle, atol=1e-5, rtol=1e-5)
            for row in range(batch):
                independent = model(ids[row:row+1, :consumed][:, -16:])[:, -1]
                torch.testing.assert_close(logits[row:row+1], independent, atol=1e-5, rtol=1e-5)
        assert torch.equal(logits.argmax(-1), oracle.argmax(-1))
        assert state.position == min(consumed, 16)
        assert state.total_tokens == consumed
        assert state.rebuilt == (previous is None or consumed > 16)
        assert state.cache_bytes <= state.reserved_bytes <= policy.max_cache_bytes
        if previous is not None:
            assert previous.total_tokens == consumed - count


@pytest.mark.parametrize("ternary", [False, True])
@pytest.mark.parametrize("prefix", [[2], [2, 5, 7], list(range(16)), list(range(21))])
def test_cache_greedy_tokens_eos_and_legacy_default_identical(ternary, prefix):
    model = cache_model(ternary=ternary)
    original = model.generate_greedy(prefix, 9)
    cached = model.generate_greedy(prefix, 9, inference_policy=cache_policy(model), stream_id="generation", weights_epoch=0)
    assert cached == original
    first = model.generate_greedy(prefix, 1)[-1]
    model.cfg = replace(model.cfg, eos_token_id=first)
    # EOS changes only stopping: blocks' unchanged attention config is still valid.
    assert model.generate_greedy(prefix, 9, inference_policy=cache_policy(model), stream_id="eos", weights_epoch=1) == prefix + [first]


def test_cache_default_training_forward_gradients_and_identity_unchanged():
    model = cache_model(ternary=True)
    pristine = cache_model(ternary=True)
    names = tuple(model.state_dict())
    cfg, count = model.cfg.to_json(), model.param_count()
    model.inference_step(torch.tensor([[2, 5, 7]]), policy=cache_policy(model), stream_id="training-check", weights_epoch=0)
    assert tuple(model.state_dict()) == names == tuple(pristine.state_dict())
    assert model.cfg.to_json() == cfg == pristine.cfg.to_json()
    assert model.param_count() == count == pristine.param_count()
    for name, value in model.state_dict().items():
        assert torch.equal(value, pristine.state_dict()[name])
    ids, targets = torch.tensor([[2, 5, 7, 9]]), torch.tensor([[5, 7, 9, 11]])
    for checkpoint in [False, True]:
        for m in [model, pristine]:
            m.train(); m.enable_gradient_checkpointing(checkpoint); m.zero_grad()
        torch.testing.assert_close(model(ids), pristine(ids), atol=0, rtol=0)
        loss = model(ids, targets, loss_chunk_tokens=2)
        other = pristine(ids, targets, loss_chunk_tokens=2)
        torch.testing.assert_close(loss, other, atol=0, rtol=0)
        loss.backward(); other.backward()
        for p, q in zip(model.parameters(), pristine.parameters()):
            torch.testing.assert_close(p.grad, q.grad, atol=0, rtol=0)


def test_cache_bindings_reject_cross_stream_model_epoch_policy_dtype_and_mutation():
    model = cache_model()
    policy = cache_policy(model)
    ids = torch.tensor([[2, 5, 7]])
    _, state = model.inference_step(ids, policy=policy, stream_id="one", weights_epoch=0)
    step = lambda **kw: model.inference_step(torch.tensor([[9]]), policy=kw.pop("policy", policy), stream_id=kw.pop("stream_id", "one"), weights_epoch=kw.pop("weights_epoch", 0), state=state, **kw)
    with pytest.raises(ValueError, match="binding"):
        step(stream_id="other")
    with pytest.raises(ValueError, match="binding"):
        step(weights_epoch=1)
    with pytest.raises(ValueError, match="binding"):
        step(policy=replace(policy, max_cache_bytes=2_000_000))
    with pytest.raises(ValueError, match="binding"):
        cache_model().inference_step(torch.tensor([[9]]), policy=policy, stream_id="one", weights_epoch=0, state=state)
    with torch.no_grad():
        model.TokenEmb.add_(0.1)
    with pytest.raises(ValueError, match="binding"):
        step()
    _, fresh = model.inference_step(ids, policy=policy, stream_id="one", weights_epoch=1)
    fresh._layers[0][0].add_(1)
    with pytest.raises(ValueError, match="tensor changed"):
        model.inference_step(torch.tensor([[9]]), policy=policy, stream_id="one", weights_epoch=1, state=fresh)
    model.double()
    with pytest.raises(ValueError, match="binding"):
        step()


@pytest.mark.parametrize("limit", ["max_cache_bytes", "max_tokens", "max_batch", "max_total_tokens"])
def test_cache_admits_limits_before_layer_allocation(limit):
    model = cache_model()
    seen = []
    handle = model.blocks[0].register_forward_pre_hook(lambda *args: seen.append(True))
    values = {limit: 1}
    ids = torch.tensor([[2, 5, 7], [7, 5, 2]])
    try:
        with pytest.raises(ValueError):
            model.inference_step(ids, policy=cache_policy(model, **values), stream_id="bounded", weights_epoch=0)
        assert seen == []
    finally:
        handle.remove()


def test_cache_actual_storage_staging_and_explicit_eviction_fallback():
    model = cache_model()
    policy = cache_policy(model)
    ids = torch.tensor([[2, 5, 7]])
    _, state = model.inference_step(ids, policy=policy, stream_id="evict", weights_epoch=0)
    tensors = state._tensors()
    capacity = sum({t.untyped_storage().data_ptr(): t.untyped_storage().nbytes() for t in tensors}.values())
    assert state.cache_bytes > capacity
    assert state.reserved_bytes > state.cache_bytes
    _, next_state = model.inference_step(torch.tensor([[9]]), policy=policy, stream_id="evict", weights_epoch=0, state=state, evict=True)
    assert next_state.rebuilt and next_state.total_tokens == 4
    logits, after = model.inference_step(torch.tensor([[11]]), policy=policy, stream_id="evict", weights_epoch=0, state=next_state)
    with torch.no_grad():
        torch.testing.assert_close(logits, model(torch.tensor([[2, 5, 7, 9, 11]]))[:, -1], atol=1e-5, rtol=1e-5)
    assert after.reserved_bytes > next_state.cache_bytes + after.cache_bytes
    with pytest.raises(ValueError, match="byte budget"):
        model.inference_step(ids, policy=replace(policy, max_cache_bytes=state.reserved_bytes-1), stream_id="evict", weights_epoch=0)


@pytest.mark.parametrize("stop_at", [1, 3, 4, 5])
def test_cache_cancel_transaction_retry_no_partial_state(stop_at):
    model = cache_model()
    checks = [0, False]
    def cancelled():
        checks[0] += 1
        return checks[1] and checks[0] >= stop_at
    policy = cache_policy(model, cancelled=cancelled)
    _, state = model.inference_step(torch.tensor([[2, 5, 7]]), policy=policy, stream_id="cancel", weights_epoch=0)
    saved = [t.clone() for t in state._tensors()]
    checks[:] = [0, True]
    with pytest.raises(InferenceCancelled):
        model.inference_step(torch.tensor([[9]]), policy=policy, stream_id="cancel", weights_epoch=0, state=state)
    assert state.total_tokens == 3
    assert all(torch.equal(a, b) for a, b in zip(saved, state._tensors()))
    checks[:] = [0, False]
    logits, _ = model.inference_step(torch.tensor([[9]]), policy=policy, stream_id="cancel", weights_epoch=0, state=state)
    with torch.no_grad():
        torch.testing.assert_close(logits, model(torch.tensor([[2, 5, 7, 9]]))[:, -1], atol=1e-5, rtol=1e-5)


def test_cache_deadline_eval_invalid_inputs_and_no_extra_eos_decode():
    model = cache_model()
    ids = torch.tensor([[2, 5, 7]])
    with pytest.raises(InferenceCancelled, match="deadline"):
        model.inference_step(ids, policy=cache_policy(model, deadline=time.monotonic()-1), stream_id="deadline", weights_epoch=0)
    model.train()
    with pytest.raises(ValueError, match="eval"):
        model.inference_step(ids, policy=cache_policy(model), stream_id="train", weights_epoch=0)
    model.eval()
    for bad in [torch.empty((1, 0), dtype=torch.long), ids.float(), torch.tensor([[64]]), torch.tensor([[-1]]), ids[0]]:
        with pytest.raises(ValueError):
            model.inference_step(bad, policy=cache_policy(model), stream_id="bad", weights_epoch=0)
    seen = []
    model.cfg = replace(model.cfg, eos_token_id=model.generate_greedy([2, 5, 7], 1)[-1])
    hook = model.blocks[0].register_forward_pre_hook(lambda *args: seen.append(True))
    try:
        result = model.generate_greedy([2, 5, 7], 8, inference_policy=cache_policy(model), stream_id="eos", weights_epoch=0)
        assert len(result) == 4 and len(seen) == 1
    finally:
        hook.remove()

@pytest.mark.parametrize("mutation", ["weights", "input", "config"])
def test_cache_rejects_mutation_during_layer_before_publication(mutation):
    model = cache_model()
    policy = cache_policy(model)
    ids = torch.tensor([[2, 5, 7]])
    def change(*args):
        if mutation == "weights":
            with torch.no_grad():
                model.TokenEmb.add_(0.1)
        elif mutation == "input":
            ids.add_(1)
        else:
            model.cfg = replace(model.cfg, rope_theta=20000)
    handle = model.blocks[0].register_forward_hook(change)
    try:
        with pytest.raises(ValueError, match="changed during inference"):
            model.inference_step(ids, policy=policy, stream_id="mutating", weights_epoch=0)
    finally:
        handle.remove()


def test_cache_cancel_before_greedy_token_publication():
    model = cache_model()
    calls = [0]
    def cancelled():
        calls[0] += 1
        return calls[0] == 6  # after completed inference_step, before out.append
    with pytest.raises(InferenceCancelled):
        model.generate_greedy([2, 5, 7], 4, inference_policy=cache_policy(model, cancelled=cancelled), stream_id="publication", weights_epoch=0)
    assert calls[0] == 6


def test_cache_offset_and_rectangular_mask_discriminator():
    model = cache_model()
    policy = cache_policy(model)
    prefix, chunk = torch.tensor([[1, 19, 7, 33, 5]]), torch.tensor([[9, 11]])
    _, state = model.inference_step(prefix, policy=policy, stream_id="offset", weights_epoch=0)
    logits, _ = model.inference_step(chunk, policy=policy, stream_id="offset", weights_epoch=0, state=state)
    with torch.no_grad():
        full = model(torch.cat((prefix, chunk), dim=1))[:, -1]
        isolated = model(chunk)[:, -1]
        assert not torch.allclose(full, isolated, atol=1e-5, rtol=1e-5)
        torch.testing.assert_close(logits, full, atol=1e-5, rtol=1e-5)


def test_cache_rollover_discriminator():
    model = cache_model(max_seq_len=4)
    policy = cache_policy(model)
    _, state = model.inference_step(torch.tensor([[2, 5, 7, 9]]), policy=policy, stream_id="roll", weights_epoch=0)
    logits, following = model.inference_step(torch.tensor([[11]]), policy=policy, stream_id="roll", weights_epoch=0, state=state)
    assert following.rebuilt and following.position == 4
    with torch.no_grad():
        torch.testing.assert_close(logits, model(torch.tensor([[5, 7, 9, 11]]))[:, -1], atol=1e-5, rtol=1e-5)


def test_cache_cross_stream_discriminator():
    model = cache_model()
    policy = cache_policy(model)
    _, state = model.inference_step(torch.tensor([[2, 5, 7]]), policy=policy, stream_id="one", weights_epoch=0)
    with pytest.raises(ValueError, match="binding"):
        model.inference_step(torch.tensor([[9]]), policy=policy, stream_id="other", weights_epoch=0, state=state)


def test_cache_epoch_discriminator():
    model = cache_model()
    policy = cache_policy(model)
    _, state = model.inference_step(torch.tensor([[2, 5, 7]]), policy=policy, stream_id="epoch", weights_epoch=0)
    with pytest.raises(ValueError, match="binding"):
        model.inference_step(torch.tensor([[9]]), policy=policy, stream_id="epoch", weights_epoch=1, state=state)


def test_cache_frozen_metadata_cannot_be_rebound_and_inference_mode_rejected():
    model = cache_model()
    policy = cache_policy(model)
    _, state = model.inference_step(torch.tensor([[2, 5, 7]]), policy=policy, stream_id="one", weights_epoch=0)
    with pytest.raises(ValueError, match="metadata changed"):
        model.inference_step(torch.tensor([[9]]), policy=policy, stream_id="other", weights_epoch=0, state=replace(state, _stream="other"))
    with pytest.raises(ValueError, match="metadata changed"):
        model.inference_step(torch.tensor([[9]]), policy=policy, stream_id="one", weights_epoch=0, state=replace(state, total_tokens=0))
    with torch.inference_mode(), pytest.raises(ValueError, match="version bindings"):
        model.inference_step(torch.tensor([[2]]), policy=policy, stream_id="unversioned", weights_epoch=0)


@pytest.mark.parametrize("field", ["cache_bytes", "reserved_bytes"])
@pytest.mark.parametrize("value", [-1_000_000, 0, 1, True, "stale"])
def test_cache_rejects_invalid_accounting_before_reuse(field, value):
    model = cache_model()
    policy = cache_policy(model)
    _, state = model.inference_step(torch.tensor([[2, 5, 7]]), policy=policy, stream_id="accounting", weights_epoch=0)
    forged = replace(state, **{field: value})
    def reached(*args):
        raise AssertionError("a malformed cache reached a transformer layer")
    hook = model.blocks[0].register_forward_pre_hook(reached)
    try:
        with pytest.raises(ValueError):
            model.inference_step(torch.tensor([[9]]), policy=policy, stream_id="accounting", weights_epoch=0, state=forged)
    finally:
        hook.remove()


def test_cache_rejects_storage_resize_without_version_change():
    model = cache_model()
    policy = cache_policy(model)
    _, state = model.inference_step(torch.tensor([[2, 5, 7]]), policy=policy, stream_id="capacity", weights_epoch=0)
    storage = state._layers[0][1].untyped_storage()
    before = state._layers[0][1]._version
    storage.resize_(storage.nbytes() - 1)
    assert state._layers[0][1]._version == before
    def reached(*args):
        raise AssertionError("an undersized storage reached a transformer layer")
    hook = model.blocks[0].register_forward_pre_hook(reached)
    try:
        with pytest.raises(ValueError):
            model.inference_step(torch.tensor([[9]]), policy=policy, stream_id="capacity", weights_epoch=0, state=state)
    finally:
        hook.remove()


@pytest.mark.parametrize("tokens", [torch.tensor([2]), torch.tensor([[2., 5., 7.]])])
def test_cache_rejects_malformed_token_storage_before_reuse(tokens):
    model = cache_model()
    policy = cache_policy(model)
    _, state = model.inference_step(torch.tensor([[2, 5, 7]]), policy=policy, stream_id="shape", weights_epoch=0)
    forged = replace(state, _tokens=tokens)
    def reached(*args):
        raise AssertionError("a malformed token cache reached a transformer layer")
    hook = model.blocks[0].register_forward_pre_hook(reached)
    try:
        with pytest.raises(ValueError):
            model.inference_step(torch.tensor([[9]]), policy=policy, stream_id="shape", weights_epoch=0, state=forged)
    finally:
        hook.remove()


def test_cache_rejects_mixed_model_dtypes_before_layer_allocation():
    model = cache_model()
    model.blocks[0].attn_norm.double()
    def reached(*args):
        raise AssertionError("mixed model dtypes reached a transformer layer")
    hook = model.blocks[0].register_forward_pre_hook(reached)
    try:
        with pytest.raises(ValueError, match="homogeneous"):
            model.inference_step(torch.tensor([[2, 5, 7]]), policy=cache_policy(model), stream_id="dtype", weights_epoch=0)
    finally:
        hook.remove()


def test_cache_recounts_capacity_even_if_byte_counter_is_restamped():
    model = cache_model()
    policy = cache_policy(model)
    _, state = model.inference_step(torch.tensor([[2, 5, 7]]), policy=policy, stream_id="recount", weights_epoch=0)
    forged = replace(state, cache_bytes=state.cache_bytes - 1)
    object.__setattr__(forged, "_stamps", (forged._metadata(),) + forged._stamps[1:])
    with pytest.raises(ValueError, match="accounting does not match"):
        model.inference_step(torch.tensor([[9]]), policy=policy, stream_id="recount", weights_epoch=0, state=forged)


@pytest.mark.parametrize("layers", [(), ((None, None),), ((torch.ones(1),),)])
def test_cache_rejects_malformed_layer_storage(layers):
    model = cache_model()
    policy = cache_policy(model)
    _, state = model.inference_step(torch.tensor([[2, 5, 7]]), policy=policy, stream_id="layers", weights_epoch=0)
    with pytest.raises(ValueError, match="layer storage"):
        model.inference_step(torch.tensor([[9]]), policy=policy, stream_id="layers", weights_epoch=0,
                             state=replace(state, _layers=layers))


def test_cache_accounts_oversized_prompt_validation_before_allocation():
    model = cache_model()
    policy = cache_policy(model, max_total_tokens=8192)
    _, state = model.inference_step(torch.arange(16)[None, :], policy=policy, stream_id="validation", weights_epoch=0)
    bounded = replace(policy, max_cache_bytes=state.reserved_bytes)
    def reached(*args):
        raise AssertionError("an unadmitted prompt reached a transformer layer")
    hook = model.blocks[0].register_forward_pre_hook(reached)
    try:
        with pytest.raises(ValueError, match="byte budget"):
            model.inference_step((torch.arange(4096) % 64)[None, :], policy=bounded, stream_id="validation", weights_epoch=0)
    finally:
        hook.remove()


@pytest.mark.parametrize("dtype,atol,rtol", [
    (torch.float64, 1e-5, 1e-5), (torch.float32, 1e-5, 1e-5),
    (torch.float16, 3e-3, 3e-3), (torch.bfloat16, 3e-2, 3e-2),
])
def test_cache_homogeneous_dtype_parity_and_accounting(dtype, atol, rtol):
    model = cache_model().to(dtype=dtype)
    policy = cache_policy(model)
    ids = (torch.arange(20) * 7 + 2).remainder(64)[None, :]
    state, consumed = None, 0
    for count in [3, 2, 12, 1]:
        logits, state = model.inference_step(ids[:, consumed:consumed + count], policy=policy,
                                            stream_id="precision", weights_epoch=0, state=state)
        consumed += count
        with torch.no_grad():
            oracle = model(ids[:, max(0, consumed - 16):consumed])[:, -1]
        torch.testing.assert_close(logits, oracle, atol=atol, rtol=rtol)
        assert torch.equal(logits.argmax(-1), oracle.argmax(-1))
        assert all(t.dtype == dtype for pair in state._layers for t in pair)
        assert state._validate_tensors() == state.cache_bytes
        assert 0 < state.cache_bytes <= state.reserved_bytes <= policy.max_cache_bytes
