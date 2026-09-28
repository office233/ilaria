"""Ternary (BitNet b1.58-style) training mode of the forge model."""
import argparse
import os
import sys
import tempfile

import torch
import torch.nn.functional as F

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ilaria_model import IlariaConfig, IlariaTransformer, act_quant, weight_quant  # noqa: E402
from nxtf import _ordered_tensors, save_nxtf  # noqa: E402
from training_state import training_signature  # noqa: E402


def tiny(ternary: bool) -> IlariaTransformer:
    torch.manual_seed(0)
    cfg = IlariaConfig(vocab_size=64, embed_dim=32, num_heads=4, num_layers=2, ffn_dim=64,
                       max_seq_len=16, eos_token_id=1, use_rope=True, use_swiglu=True, ternary=ternary)
    return IlariaTransformer(cfg)


def test_weight_quant_is_ternary_times_absmean():
    w = torch.randn(48, 24)
    q = weight_quant(w)
    scale = w.abs().mean()
    levels = torch.unique(torch.round(q / scale))
    assert set(levels.tolist()) <= {-1.0, 0.0, 1.0}
    assert torch.allclose(q.abs().max(), scale)


def test_act_quant_uses_8_bit_levels_per_token():
    x = torch.randn(3, 5, 16)
    q = act_quant(x)
    step = x.abs().amax(dim=-1, keepdim=True) / 127
    k = q / step
    assert torch.allclose(k, torch.round(k), atol=1e-4)
    assert k.abs().max() <= 127 + 1e-4


def test_straight_through_gradients_reach_latent_weights():
    w = torch.randn(8, 4, requires_grad=True)
    x = torch.randn(2, 8, requires_grad=True)
    (act_quant(x) @ weight_quant(w)).sum().backward()
    assert w.grad is not None and torch.isfinite(w.grad).all() and w.grad.abs().sum() > 0
    assert x.grad is not None and torch.isfinite(x.grad).all() and x.grad.abs().sum() > 0


def test_default_model_is_unchanged_and_ternary_differs():
    ids = torch.randint(0, 64, (2, 8))
    full, tern = tiny(False), tiny(True)
    tern.load_state_dict(full.state_dict())
    assert "ternary" not in full.cfg.to_go_json()
    assert tern.cfg.to_go_json()["ternary"] is True
    assert not torch.allclose(full(ids), tern(ids))


def test_ternary_model_learns_a_pattern():
    model = tiny(True)
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


def test_export_writes_the_quantized_block_weights():
    model = tiny(True)
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "t.nxtf")
        save_nxtf(model, path)
        assert os.path.getsize(path) > 0
    for t in _ordered_tensors(model):
        if t.ndim == 2 and t is not model.TokenEmb and t is not model.PosEmb:
            exported = model.export_tensor(t)
            assert torch.unique(exported).numel() <= 3
    assert torch.equal(model.export_tensor(model.TokenEmb), model.TokenEmb.detach())


def test_signature_records_ternary():
    args = argparse.Namespace(steps=1, warmup=0, lr=1e-3, min_lr=0.0, wd=0.0, ctx=4, batch=1, accum=1,
                              seed=0, compile=False, grad_checkpoint=False, eval_every=1, eval_iters=1,
                              ternary=True)
    assert training_signature(args, "cpu", None, "x", None)["arguments"]["ternary"] is True
