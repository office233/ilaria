"""forge/multimodal/lora_bitlinear.py -- LoRA adapters for the BitNet LLM's
`transformers.integrations.bitnet.AutoBitLinear` projections, for stage 2
instruction tuning (train_stage2.py). Read this alongside
`transformers/integrations/bitnet.py` (AutoBitLinear, WeightQuant, ActQuant)
and `transformers/models/bitnet/modeling_bitnet.py` (BitNetAttention/
BitNetMLP, which is where q_proj/k_proj/v_proj/o_proj/gate_proj/up_proj/
down_proj actually live) -- this module assumes, and does not re-derive,
their forward contracts.

Two frozen-base variants (`--base offline|bf16` in train_stage2.py; the
loader here is `load_frozen_base`):

  "offline" (DEFAULT, preferred for this project's pipeline) --
      microsoft/bitnet-b1.58-2B-4T, the same checkpoint mm_model.
      load_real_bitnet_llm loads for stage 1. Its AutoBitLinear modules have
      `online_quant=False`: `.weight` holds ALREADY-TERNARY values (-1/0/1,
      unpacked from the checkpoint's 2-bit-packed uint8 tensors -- see
      mm_model.load_real_bitnet_llm's docstring for the from_pretrained
      unmaterialization workaround this project needs on this transformers
      version) plus a scalar `.weight_scale`; forward = ActQuant(x) @
      weight^T, rescaled by weight_scale. 1.2 GB on disk, and -- critically
      -- the EXACT SAME weights cortex/bitnet.go's Go engine will run, so a
      LoRA delta trained against this base composes correctly with the Go
      engine's own ternary forward at inference time with no train/serve
      skew. No STE noise either (the ternary weights are fixed data, not a
      quantize-every-forward simulation). Preferred for this project.
  "bf16" (fallback, Colab-only; NOT exercised on this PC -- downloading it
      would exceed this PC's 50 MB-per-file budget, see AGENTS.md) --
      microsoft/bitnet-b1.58-2B-4T-bf16, the trainable checkpoint. Its
      config.json declares `quantization_mode: online`, so `from_pretrained`
      still converts every target nn.Linear to AutoBitLinear (transformers/
      quantizers/quantizer_bitnet.py dispatches on the checkpoint's own
      quantization_config, unconditionally -- see that file), but with
      `online_quant=True`: `.weight` is a REAL bf16 nn.Parameter, and every
      forward pass re-ternarizes it on the fly via WeightQuant's
      straight-through estimator (transformers/integrations/bitnet.py).
      This lets the BASE itself move (useful for a heavier full-finetune
      later), but the ternary weights it re-quantizes to on any given step
      are a moving target that will, in general, NOT match whatever the
      offline checkpoint's fixed packed weights are -- so a LoRA delta
      trained against this base does not obviously transfer to the Go
      engine's frozen offline weights without re-exporting the base itself
      too (out of scope here: this project only ever ships the LoRA delta,
      never a merged base -- see `merge_lora`). Costs ~4.8 GB instead of
      1.2 GB and adds STE gradient noise to every base matmul. Only use this
      if a future experiment specifically wants the base to keep moving.

LoRA math, and WHERE the delta enters (the task's explicit design question):
`LoRABitLinear.forward(x) = base(x) + (alpha/r) * B(A(dropout(x)))`, where
`base(x)` is the wrapped AutoBitLinear's own, unmodified `forward(x)` (so it
applies its own internal `ActQuant.apply(x)` to whatever copy of `x` it
receives), and the LoRA branch reads the SAME raw `x` this module's forward
receives -- i.e. the activation BEFORE AutoBitLinear's internal ActQuant, not
a quantized copy of it. Concretely, LoRABitLinear never calls ActQuant
itself; it just hands `x` to `self.base(x)` (which quantizes its own copy
internally) and, separately, computes the delta straight off the same `x`.
This is standard QLoRA-style practice, for two reasons: (1) re-quantizing x
a second time for the LoRA path would throw away exactly the extra
precision the low-rank adapter exists to add back, since the base path
already lost most of it to ActQuant's 8-bit per-token quantization; (2) it
avoids invoking ActQuant's own `@torch.compile`-wrapped forward twice per
layer for no benefit. The delta matmuls themselves are NOT quantized at
all -- they run in whatever dtype `x` and the LoRA A/B parameters are in.
A/B are kept as fp32 master weights (`lora_A`, `lora_B`), the same
optimizer-stability convention train_stage1.py documents for the projector
("trainable projector stays fp32 ... autocast during the forward pass");
under Colab's `torch.autocast(..., dtype=bf16)` (train_stage2.py) the delta
matmuls run in bf16 like everything else in that context, and on the PC's
--smoke path (no autocast) they run in plain fp32.

Target modules (`DEFAULT_TARGETS`, matching the task spec and
BitNetAttention/BitNetMLP's own attribute names): q_proj, k_proj, v_proj,
o_proj, gate_proj, up_proj, down_proj -- all 7 per layer, 30 layers on the
real 2.4B checkpoint (210 AutoBitLinear modules total, same count
mm_model.load_real_bitnet_llm's docstring cites for the unmaterialization
fix).
"""

from __future__ import annotations

import math
import os
import re
import sys
from typing import Iterable

import torch
import torch.nn as nn
import torch.nn.functional as F

DEFAULT_TARGETS = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]

# "model.layers.<i>.self_attn.q_proj" / "model.layers.<i>.mlp.gate_proj" --
# confirmed against transformers/models/bitnet/modeling_bitnet.py's
# BitNetModel (self.layers = nn.ModuleList(...)) and BitNetForCausalLM
# (self.model = BitNetModel(config)): named_modules() on the top-level LLM
# yields exactly this shape for every target projection, real checkpoint or
# the --smoke tiny stand-in alike (both are BitNetForCausalLM instances).
LAYER_PROJ_RE = re.compile(r"\.layers\.(\d+)\.(?:self_attn|mlp)\.(\w+)$")


def _autobitlinear_cls():
    from transformers.integrations.bitnet import AutoBitLinear
    return AutoBitLinear


class LoRABitLinear(nn.Module):
    """Wraps one frozen `AutoBitLinear` `base` with a trainable low-rank
    delta. See the module docstring for the exact forward math and where the
    delta enters relative to `base`'s own ActQuant. `base` itself is frozen
    here (`requires_grad_(False)` on every one of its parameters) -- callers
    should not rely on it having been frozen already."""

    def __init__(self, base: nn.Module, r: int = 16, alpha: int = 32, dropout: float = 0.0):
        super().__init__()
        AutoBitLinear = _autobitlinear_cls()
        if not isinstance(base, AutoBitLinear):
            raise TypeError(f"LoRABitLinear expects an AutoBitLinear base, got {type(base).__name__}")
        if r <= 0:
            raise ValueError(f"r must be positive, got {r}")
        self.base = base
        for p in self.base.parameters():
            p.requires_grad_(False)

        self.in_features = base.in_features
        self.out_features = base.out_features
        self.r = r
        self.alpha = alpha
        self.scaling = alpha / r
        self.lora_dropout = nn.Dropout(dropout) if dropout > 0 else nn.Identity()

        # fp32 master weights -- see module docstring's "LoRA math" section
        # for why (matches train_stage1.py's projector convention).
        self.lora_A = nn.Parameter(torch.empty(r, self.in_features, dtype=torch.float32))
        self.lora_B = nn.Parameter(torch.zeros(self.out_features, r, dtype=torch.float32))
        nn.init.kaiming_uniform_(self.lora_A, a=math.sqrt(5))
        # lora_B intentionally left at zero-init (standard LoRA, Hu et al.
        # 2021): the delta contributes exactly nothing until training moves
        # B away from zero, so a freshly injected model's forward is
        # bit-identical to the un-adapted base (see
        # tests/test_lora_bitlinear.py's test_zero_b_matches_base).

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        base_out = self.base(x)
        # `x` here is the pre-ActQuant activation -- see module docstring.
        lora_in = self.lora_dropout(x).to(self.lora_A.dtype)
        delta = F.linear(F.linear(lora_in, self.lora_A), self.lora_B) * self.scaling
        return base_out + delta.to(base_out.dtype)

    def extra_repr(self) -> str:
        return f"in_features={self.in_features}, out_features={self.out_features}, r={self.r}, alpha={self.alpha}"


def _iter_target_leaves(model: nn.Module, targets: Iterable[str]):
    AutoBitLinear = _autobitlinear_cls()
    target_set = set(targets)
    for name, module in model.named_modules():
        leaf = name.rsplit(".", 1)[-1]
        if leaf in target_set and isinstance(module, AutoBitLinear):
            yield name, module


def inject_lora(model: nn.Module, targets: Iterable[str] | None = None, r: int = 16, alpha: int = 32,
                 dropout: float = 0.0) -> list:
    """Replaces every `AutoBitLinear` submodule of `model` whose leaf
    attribute name is in `targets` with a `LoRABitLinear` wrapping it, IN
    PLACE (the original module -- and its already-loaded weights/
    weight_scale/online_quant flag -- becomes the new module's `.base`, so
    the exact frozen weights the caller loaded keep being used; only the new
    A/B matrices are added on top). Returns the flat list of newly created
    trainable `nn.Parameter`s (`lora_A`, `lora_B` for every wrapped module,
    in injection order) -- pass straight to an optimizer param group.

    Raises `ValueError` if no matching `AutoBitLinear` modules are found
    (almost always a sign `targets` doesn't match this model's attribute
    names, or `model` was never converted to AutoBitLinear in the first
    place -- see `load_frozen_base`)."""
    targets = list(targets or DEFAULT_TARGETS)
    hits = list(_iter_target_leaves(model, targets))
    if not hits:
        raise ValueError(f"inject_lora found no AutoBitLinear modules matching targets={targets} in this model")
    trainable: list = []
    for name, module in hits:
        wrapped = LoRABitLinear(module, r=r, alpha=alpha, dropout=dropout)
        parent_name, _, leaf = name.rpartition(".")
        parent = model.get_submodule(parent_name) if parent_name else model
        setattr(parent, leaf, wrapped)
        trainable.append(wrapped.lora_A)
        trainable.append(wrapped.lora_B)
    return trainable


def lora_modules(model: nn.Module) -> dict:
    """{dotted module path: LoRABitLinear} for every LoRABitLinear currently
    in `model` (i.e. whatever `inject_lora` created)."""
    return {name: mod for name, mod in model.named_modules() if isinstance(mod, LoRABitLinear)}


def merge_lora(model: nn.Module) -> None:
    """NOT SUPPORTED, by design -- always raises. Merging `B @ A` into
    `base.weight` is not a meaningful operation for either `--base` variant
    this project uses:

      - offline: `base.weight` holds ALREADY-TERNARY values (-1/0/1) plus a
        single scalar `weight_scale`. `B @ A` is a dense, full-precision
        matrix; adding it to the ternary weight and re-quantizing back to
        {-1,0,1} would throw away almost everything the LoRA update was
        trained to add (unlike merging at full precision, this is very much
        NOT a no-op) -- and even the un-requantized dense sum could no
        longer be packed into the 2-bit ternary representation the Go
        engine (cortex/bitnet.go / bitnet_linear.go) and the exported NXTF
        format require.
      - bf16: `base.weight` is a real bf16 Parameter, so merging is at least
        numerically possible there -- but is intentionally not implemented
        either, to keep both `--base` variants' export contract identical:
        stage 2 always ships the LoRA delta as SEPARATE A/B tensors
        (export_stage2.py), and the Go engine applies
        `y = base(x) + (alpha/r) * B(A(x))` itself at inference time. A
        merge helper here would invite a second, divergent export path.

    Use `lora_state_dict()` / `export_stage2.py` to ship the LoRA delta
    alongside the frozen base instead."""
    raise NotImplementedError(
        "merge_lora() is not supported: the frozen base's AutoBitLinear.weight is either already-ternary "
        "(offline -- merging would destroy the ternary representation) or intentionally kept separate from "
        "the LoRA delta (bf16 -- see export_stage2.py, which the Go engine's inference-time delta application "
        "depends on). Use lora_state_dict()/export_stage2.py to export A/B instead."
    )


def lora_state_dict(model: nn.Module) -> dict:
    """{dotted module path: {"A": Tensor[r,in], "B": Tensor[out,r], "r": int,
    "alpha": int}} for every LoRABitLinear in `model`, detached and moved to
    CPU (safe to `torch.save` directly, e.g. inside train_stage2.py's
    checkpoint dict)."""
    out = {}
    for name, mod in lora_modules(model).items():
        out[name] = {
            "A": mod.lora_A.detach().cpu().clone(),
            "B": mod.lora_B.detach().cpu().clone(),
            "r": mod.r,
            "alpha": mod.alpha,
        }
    return out


def load_lora_state_dict(model: nn.Module, state: dict, strict: bool = True) -> int:
    """Loads a dict shaped like `lora_state_dict()`'s output into `model`'s
    EXISTING LoRABitLinear modules in place (`.data.copy_`, so each
    Parameter keeps its own device/dtype -- `state`'s tensors are cast to
    match). Returns the number of modules loaded.

    `strict=True` (default) raises `KeyError` if `state` names a module path
    `model` doesn't have a LoRABitLinear at (or vice versa) -- almost always
    a sign the caller injected LoRA with different `targets`/layer count
    than whatever produced `state`."""
    modules = lora_modules(model)
    if strict:
        missing = set(modules) - set(state)
        unexpected = set(state) - set(modules)
        if missing or unexpected:
            raise KeyError(f"lora_state_dict mismatch: missing={sorted(missing)} unexpected={sorted(unexpected)}")
    n = 0
    for name, entry in state.items():
        mod = modules.get(name)
        if mod is None:
            continue
        if mod.lora_A.shape != entry["A"].shape or mod.lora_B.shape != entry["B"].shape:
            raise ValueError(f"{name}: shape mismatch loading LoRA state (A {mod.lora_A.shape} vs {entry['A'].shape})")
        mod.lora_A.data.copy_(entry["A"].to(device=mod.lora_A.device, dtype=mod.lora_A.dtype))
        mod.lora_B.data.copy_(entry["B"].to(device=mod.lora_B.device, dtype=mod.lora_B.dtype))
        n += 1
    return n


def export_key(module_path: str) -> str:
    """"model.layers.3.self_attn.q_proj" -> "lora.layers.3.q_proj" -- the
    tensor-name convention export_stage2.py writes (`.A`/`.B` appended by
    the caller). Shared here so train_stage2.py and export_stage2.py (and
    any future Go importer) agree on exactly one naming scheme instead of
    each re-deriving it."""
    m = LAYER_PROJ_RE.search(module_path)
    if not m:
        raise ValueError(f"export_key: can't parse a '...layers.<i>.(self_attn|mlp).<proj>' suffix out of {module_path!r}")
    layer_idx, proj = m.group(1), m.group(2)
    return f"lora.layers.{layer_idx}.{proj}"


def load_frozen_base(base: str, llm_dir: str):
    """`base`: "offline" | "bf16" -> a frozen (`requires_grad=False` on
    every parameter), `eval()`-mode BitNetForCausalLM ready for
    `inject_lora`. See the module docstring's "Two frozen-base variants"
    section for the trade-off this flag controls. `llm_dir` is a local
    directory (this project never downloads a checkpoint mid-run -- see
    AGENTS.md); for "bf16" that means a LOCAL copy of
    microsoft/bitnet-b1.58-2B-4T-bf16, which this PC does not have (~4.8 GB,
    over the 50 MB/file budget) -- that path is Colab-only and untested
    here; "offline" is data/pretrained/bitnet-b1.58-2B-4T, already local."""
    if base == "offline":
        # Reuse (never modify) mm_model's loader -- it already carries the
        # from_pretrained unmaterialization workaround this checkpoint
        # needs on this transformers version (see its own docstring).
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from mm_model import load_real_bitnet_llm  # noqa: E402

        model = load_real_bitnet_llm(llm_dir)
    elif base == "bf16":
        from transformers import AutoModelForCausalLM

        model = AutoModelForCausalLM.from_pretrained(llm_dir, torch_dtype=torch.bfloat16, low_cpu_mem_usage=True)
        model.eval()
    else:
        raise ValueError(f"load_frozen_base: base must be 'offline' or 'bf16', got {base!r}")

    for p in model.parameters():
        p.requires_grad_(False)
    return model
