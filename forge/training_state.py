"""Versioned, weights-only-loadable training state. Not a cross-platform bitwise guarantee."""
from __future__ import annotations

import copy
import hashlib
import random
from pathlib import Path

import numpy as np
import torch

SCHEMA_VERSION = 2


def file_sha256(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def capture_rng(rng: np.random.Generator) -> dict:
    return {
        "numpy": copy.deepcopy(rng.bit_generator.state),
        "python": random.getstate(),
        "torch_cpu": torch.get_rng_state(),
        "torch_cuda": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else [],
    }


def restore_rng(state: dict, rng: np.random.Generator) -> None:
    # All tensors are loaded on CPU, including CUDA RNG state byte tensors.
    if set(state) != {"numpy", "python", "torch_cpu", "torch_cuda"}:
        raise ValueError("checkpoint is missing RNG state")
    cuda_states = state["torch_cuda"]
    count = torch.cuda.device_count() if torch.cuda.is_available() else 0
    if len(cuda_states) != count:
        raise ValueError("checkpoint CUDA device count differs; exact resume is unavailable")
    rng.bit_generator.state = state["numpy"]
    random.setstate(state["python"])
    torch.set_rng_state(state["torch_cpu"].cpu())
    if cuda_states:
        torch.cuda.set_rng_state_all([s.cpu() for s in cuda_states])


def training_signature(args, device: str, precision, data_sha256: str,
                       tokenizer_sha256: str | None) -> dict:
    # The total LR horizon is immutable. --stop-after does NOT shorten it.
    fields = ("steps", "warmup", "lr", "min_lr", "wd", "ctx", "batch", "accum",
              "seed", "compile", "grad_checkpoint", "eval_every", "eval_iters")
    arguments = {k: getattr(args, k) for k in fields}
    if getattr(args, "ternary", False):
        arguments["ternary"] = True  # absent for full precision: old checkpoints still resume
    if getattr(args, "arch", "ilaria") != "ilaria":
        arguments["arch"] = args.arch
    return {
        "arguments": arguments,
        "device": device,
        "precision": str(precision),
        "torch_version": str(torch.__version__),
        "numpy_version": str(np.__version__),
        "data_sha256": data_sha256,
        "tokenizer_sha256": tokenizer_sha256,
    }


def config_json(model) -> dict:
    """The checkpoint's config record: Go-twin models keep their Go JSON, IMC its own."""
    cfg = model.cfg
    return cfg.to_go_json() if hasattr(cfg, "to_go_json") else {"arch": "imc"} | cfg.to_json()


def make_checkpoint(model, optimizer, scaler, rng, step: int, best_val: float,
                    tokens_seen: int, signature: dict, best_nxtf_sha256: str | None = None) -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "model": model.state_dict(), "opt": optimizer.state_dict(),
        "scaler": scaler.state_dict(), "rng": capture_rng(rng),
        "step": step, "best_val": best_val, "tokens_seen": tokens_seen,
        "cfg": config_json(model), "signature": signature,
        "best_nxtf_sha256": best_nxtf_sha256,
    }


def restore_checkpoint(ck: dict, model, optimizer, scaler, rng, signature: dict):
    """Validate compatibility before changing the model or optimizer.

    Legacy files deliberately fail closed; they lack the information necessary
    for exact resume. They remain usable as weight initialization outside this API.
    """
    if not isinstance(ck, dict) or ck.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("checkpoint has no supported resume schema; use it only as weight initialization")
    required = {"model", "opt", "scaler", "rng", "step", "best_val", "tokens_seen", "cfg", "signature"}
    if not required.issubset(ck):
        raise ValueError("incomplete training checkpoint")
    if ck["cfg"] != config_json(model):
        raise ValueError("checkpoint model configuration differs from this job")
    if ck["signature"] != signature:
        raise ValueError("checkpoint training signature differs (data/tokenizer/schedule/runtime)")
    step, tokens = ck["step"], ck["tokens_seen"]
    if type(step) is not int or not 0 <= step <= signature["arguments"]["steps"]:
        raise ValueError("invalid checkpoint step")
    if type(tokens) is not int or tokens < 0:
        raise ValueError("invalid checkpoint token count")
    best = ck["best_val"]
    if type(best) not in (int, float) or np.isnan(best) or best == float("-inf"):
        raise ValueError("invalid checkpoint best validation loss")
    first_eval = min(signature["arguments"].get("eval_every", signature["arguments"]["steps"]),
                     signature["arguments"]["steps"])
    if best == float("inf") and step >= first_eval:
        raise ValueError("invalid checkpoint best validation loss")
    model.load_state_dict(ck["model"], strict=True)
    optimizer.load_state_dict(ck["opt"])
    scaler.load_state_dict(ck["scaler"])
    restore_rng(ck["rng"], rng)
    return step, float(best), tokens


def initialize_weights(ck: dict, model) -> None:
    """Explicit warm start for legacy checkpoints; never presented as resume."""
    def normalized(cfg):
        # A missing "ternary" (every checkpoint before it existed) means full precision.
        return {"ternary": False} | cfg if isinstance(cfg, dict) else cfg

    if (not isinstance(ck, dict) or normalized(ck.get("cfg")) != normalized(config_json(model))
            or "model" not in ck):
        raise ValueError("weight initialization requires a matching checkpoint configuration")
    model.load_state_dict(ck["model"], strict=True)
