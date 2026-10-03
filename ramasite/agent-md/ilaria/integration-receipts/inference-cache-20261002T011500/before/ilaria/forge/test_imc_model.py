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
