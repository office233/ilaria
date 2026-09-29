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


def tiny(**kw) -> ImcTransformer:
    torch.manual_seed(0)
    cfg = ImcConfig(vocab_size=64, d_model=32, n_layers=2, n_heads=4, n_kv_heads=2, ffn_dim=48,
                    max_seq_len=16, **kw)
    return ImcTransformer(cfg)


@pytest.mark.parametrize("name,target", [("imc-125m", 125e6), ("imc-250m", 250e6),
                                         ("imc-500m", 500e6), ("imc-1b", 981e6)])
def test_presets_hit_their_size_with_a_65536_vocab(name, target):
    cfg = ImcConfig.preset(name, vocab_size=65536, max_seq_len=16)
    assert abs(cfg.param_count() - target) / target < 0.03, cfg.param_count()


def test_imc_1b_matches_the_spec():
    cfg = PRESETS["imc-1b"]
    assert (cfg["d_model"], cfg["n_layers"], cfg["n_heads"], cfg["n_kv_heads"], cfg["ffn_dim"]) == (2048, 16, 16, 4, 6912)


def test_param_count_formula_matches_the_module():
    model = tiny()
    assert model.cfg.param_count() == sum(p.numel() for p in model.parameters())


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


def test_trainer_runs_resumes_and_exports_ternary_imc(tmp_path):
    import json as _json
    import subprocess

    import numpy as np
    rng = np.random.default_rng(0)
    tokens = np.tile(np.arange(4, 36, dtype="<u2"), 400) ^ rng.integers(0, 2, 12800, dtype="<u2")
    prefix = tmp_path / "stream"
    tokens.tofile(str(prefix) + ".bin")
    (tmp_path / "stream.json").write_text(_json.dumps({"dtype": "uint16", "vocab_size": 40, "eos_id": 3}))
    out = tmp_path / "run"
    trainer = os.path.join(os.path.dirname(os.path.abspath(__file__)), "train_ilaria.py")
    base = [sys.executable, trainer, "--data", str(prefix), "--out", str(out), "--arch", "imc", "--ternary",
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


def _tiny_stream(tmp_path):
    import json as _json

    import numpy as np
    rng = np.random.default_rng(0)
    tokens = np.tile(np.arange(4, 36, dtype="<u2"), 400) ^ rng.integers(0, 2, 12800, dtype="<u2")
    prefix = tmp_path / "stream"
    tokens.tofile(str(prefix) + ".bin")
    (tmp_path / "stream.json").write_text(_json.dumps({"dtype": "uint16", "vocab_size": 40, "eos_id": 3}))
    return prefix


TINY_ARGS = ["--arch", "imc", "--ternary", "--embed-dim", "32", "--heads", "4", "--kv-heads", "2",
             "--layers", "2", "--ffn-dim", "48", "--ctx", "16", "--max-seq-len", "16", "--batch", "4",
             "--warmup", "4", "--lr", "3e-3", "--min-lr", "3e-4", "--eval-iters", "2", "--precision", "fp32"]


def test_two_process_ddp_with_chunked_loss_trains_and_saves_once(tmp_path):
    import json as _json
    import socket
    import subprocess
    prefix, out = _tiny_stream(tmp_path), tmp_path / "run"
    trainer = os.path.join(os.path.dirname(os.path.abspath(__file__)), "train_ilaria.py")
    args = [trainer, "--data", str(prefix), "--out", str(out), "--chunked-loss", "--accum", "2",
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
