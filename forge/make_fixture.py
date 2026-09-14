"""make_fixture.py — produce the Go↔PyTorch equivalence fixture.

Builds a tiny random model in BOTH configurations (GPT-2 form, and
RoPE+SwiGLU form), exports each to NXTF2BIN, and records the fp32 logits
of the last position for a fixed input. cortex/forge_equivalence_test.go
loads the .nxtf in Go, runs Forward, and compares.

    python forge/make_fixture.py
"""

from __future__ import annotations

import json
import os
import sys

import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ilaria_model import IlariaConfig, IlariaTransformer  # noqa: E402
from nxtf import save_nxtf  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def build(name: str, cfg: IlariaConfig, seed: int) -> None:
    torch.manual_seed(seed)
    model = IlariaTransformer(cfg).eval()
    ids = [2, 5, 11, 7, 4, 9, 13, 3, 6]
    with torch.no_grad():
        logits = model(torch.tensor(ids)[None, :])[0]  # [T, V]
    os.makedirs(OUT, exist_ok=True)
    save_nxtf(model, os.path.join(OUT, f"{name}.nxtf"))
    with open(os.path.join(OUT, f"{name}.json"), "w") as f:
        json.dump({
            "input_ids": ids,
            "logits_last": logits[-1].tolist(),
            "logits_first": logits[0].tolist(),
            "argmax_last": int(torch.argmax(logits[-1])),
        }, f)
    print(f"[fixture] {name}: {model.param_count()} params -> {OUT}/{name}.nxtf")


if __name__ == "__main__":
    build("tiny_gpt2", IlariaConfig(vocab_size=40, embed_dim=16, num_heads=2,
                                    num_layers=2, ffn_dim=32, max_seq_len=16, eos_token_id=3), 1)
    build("tiny_modern", IlariaConfig(vocab_size=40, embed_dim=16, num_heads=2,
                                      num_layers=2, ffn_dim=32, max_seq_len=16, eos_token_id=3,
                                      use_rope=True, use_swiglu=True), 2)
