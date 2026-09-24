"""forge/multimodal/vision_adapter.py -- SigLIP2 vision tower -> pixel-shuffle
token reduction -> 2-layer MLP projector, producing BitNet-hidden-sized image
embeddings for stage P3 "eyes" (docs/research/2026-09-24-ilaria-1.58-multimodal-studiu.md
sections 4 and 6, plan step P3).

Architecture (LLaVA/SmolVLM-style):

    pixel_values [B,3,H,W]
        -> frozen SigLIP2 vision tower (AutoModel; takes .vision_model if the
           repo is a full dual-encoder SiglipModel) -> patch tokens
           [B, P, C_vis] where P = (H/patch)*(W/patch)
        -> pixel shuffle: group each sxs block of adjacent patches into one
           token, concatenating their channels -> [B, ~P/s^2, C_vis*s^2]
        -> 2-layer MLP projector (Linear -> GELU -> Linear) -> [B, N, hidden]

Token count math (512 px / patch 16 / shuffle 3) -- see `grid_and_token_count`,
also used by mm_model.py (to size the spliced embedding sequence) and
export_adapter.py (to document the exported adapter's expected input shape):

    patch grid side = 512 / 16 = 32  (NOT divisible by 3)
    "pad" policy (default): zero-pad the grid up to the next multiple of s
        -> ceil(32/3) = 11 -> 11*11 = 121 tokens/image (no patch dropped)
    "crop" policy: drop the trailing rows/cols that do not fill a full block
        -> floor(32/3) = 10 -> 10*10 = 100 tokens/image
    The naive "1024/9 ~= 113.8" estimate assumes exact divisibility, which
    does not hold at shuffle 3 -- 121 (pad, default) or 100 (crop) are the
    real integers. Shuffle 2 divides evenly either way: 16*16 = 256
    tokens/image, no padding/cropping needed.

`--tower random-tiny` builds a tiny, randomly-initialized SiglipVisionModel
(no download, no network) for train_stage1.py's --smoke path.
"""

from __future__ import annotations

import gc
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F

TOWER_REPOS = {
    "siglip2-base": "google/siglip2-base-patch16-512",
    "siglip2-large": "google/siglip2-large-patch16-512",
}


@dataclass
class VisionAdapterConfig:
    tower: str = "siglip2-base"   # "siglip2-base" | "siglip2-large" | "random-tiny" | any HF repo id
    shuffle_factor: int = 3       # 2 or 3
    grid_policy: str = "pad"      # "pad" (zero-pad, default, no patch dropped) | "crop"
    llm_hidden: int = 2560        # microsoft/bitnet-b1.58-2B-4T hidden_size
    mlp_hidden: int = 0           # 0 -> defaults to llm_hidden
    freeze_tower: bool = True

    def __post_init__(self):
        if self.shuffle_factor not in (2, 3):
            raise ValueError(f"shuffle_factor must be 2 or 3, got {self.shuffle_factor}")
        if self.grid_policy not in ("pad", "crop"):
            raise ValueError(f"grid_policy must be 'pad' or 'crop', got {self.grid_policy!r}")
        if self.mlp_hidden <= 0:
            self.mlp_hidden = self.llm_hidden

    def tower_repo(self) -> str:
        return TOWER_REPOS.get(self.tower, self.tower)

    def to_json(self) -> dict:
        return {
            "tower": self.tower,
            "tower_repo": None if self.tower == "random-tiny" else self.tower_repo(),
            "shuffle_factor": self.shuffle_factor,
            "grid_policy": self.grid_policy,
            "llm_hidden": self.llm_hidden,
            "mlp_hidden": self.mlp_hidden,
        }


def grid_side(image_size: int, patch_size: int) -> int:
    if image_size % patch_size != 0:
        raise ValueError(f"image_size {image_size} not divisible by patch_size {patch_size}")
    return image_size // patch_size


def reduced_grid_side(side: int, s: int, policy: str) -> int:
    return -(-side // s) if policy == "pad" else side // s  # ceil-div for pad, floor-div for crop


def grid_and_token_count(image_size: int, patch_size: int, shuffle_factor: int, grid_policy: str) -> dict:
    """Exact token-count arithmetic used by VisionAdapter, mm_model.py and
    export_adapter.py without needing to instantiate the tower."""
    side = grid_side(image_size, patch_size)
    r_side = reduced_grid_side(side, shuffle_factor, grid_policy)
    return {
        "patch_grid_side": side,
        "patches": side * side,
        "reduced_grid_side": r_side,
        "tokens_per_image": r_side * r_side,
    }


def pixel_shuffle(x: torch.Tensor, h: int, w: int, s: int, policy: str) -> torch.Tensor:
    """[B, H*W, C] patch tokens -> [B, N', C*s*s] shuffled tokens.

    Groups each contiguous sxs block of patches (row-major over the H,W
    patch grid) into a single token by concatenating their channel vectors.
    "pad": zero-pads H,W up to the next multiple of s first (default -- every
    patch is kept). "crop": drops the trailing rows/cols that do not fill a
    full sxs block. The channel-concat order is this module's own (not
    required to bit-match any reference implementation) -- it only needs to
    be internally consistent, since the projector is trained from scratch
    on top of it.
    """
    b, n, c = x.shape
    if n != h * w:
        raise ValueError(f"expected {h}*{w}={h * w} patch tokens, got {n}")
    x = x.view(b, h, w, c)

    if policy == "pad":
        pad_h, pad_w = (-h) % s, (-w) % s
        if pad_h or pad_w:
            # F.pad on [B,H,W,C] pads the last dim first: (c_lo,c_hi, w_lo,w_hi, h_lo,h_hi)
            x = F.pad(x, (0, 0, 0, pad_w, 0, pad_h))
        h, w = h + pad_h, w + pad_w
    else:  # "crop"
        h, w = (h // s) * s, (w // s) * s
        x = x[:, :h, :w, :]

    x = x.view(b, h // s, s, w // s, s, c)
    x = x.permute(0, 1, 3, 2, 4, 5).contiguous()
    x = x.view(b, (h // s) * (w // s), s * s * c)
    return x


def _build_tiny_tower():
    """A randomly-initialized, undownloaded SiglipVisionModel for --tower
    random-tiny (smoke tests only -- not a real vision encoder)."""
    from transformers.models.siglip.configuration_siglip import SiglipVisionConfig
    from transformers.models.siglip.modeling_siglip import SiglipVisionModel

    cfg = SiglipVisionConfig(
        hidden_size=32, intermediate_size=64, num_hidden_layers=2, num_attention_heads=2,
        num_channels=3, image_size=64, patch_size=16, layer_norm_eps=1e-6,
    )
    model = SiglipVisionModel(cfg)
    return model, cfg


def _load_real_tower(repo: str):
    """AutoModel-loads the tower repo (per the task spec) and extracts just
    the vision tower. google/siglip2-base-patch16-512 / -large-... ship as a
    full dual-encoder SiglipModel (text_model + vision_model + projections)
    despite the "siglip2" name -- their config.json declares model_type
    "siglip" (fixed 512px resolution, the original SiglipModel architecture;
    the NaFlex variable-resolution Siglip2Model architecture is a separate
    family of checkpoints this project does not use). We keep only
    `.vision_model` and drop the text tower to save memory."""
    from transformers import AutoModel

    full = AutoModel.from_pretrained(repo, torch_dtype=torch.float32)
    if hasattr(full, "vision_model"):
        tower = full.vision_model
        full.vision_model = None  # detach so `del full; gc.collect()` can reclaim the text tower
        del full
        gc.collect()
    else:
        tower = full
    return tower, tower.config


class VisionAdapter(nn.Module):
    """Frozen SigLIP2 tower -> pixel shuffle -> trainable 2-layer MLP
    projector. `.trainable_parameters()` gives the stage-1 optimizer's only
    param group (the projector)."""

    def __init__(self, config: VisionAdapterConfig):
        super().__init__()
        self.config = config
        if config.tower == "random-tiny":
            self.tower, tower_cfg = _build_tiny_tower()
        else:
            self.tower, tower_cfg = _load_real_tower(config.tower_repo())

        self.image_size = tower_cfg.image_size
        self.patch_size = tower_cfg.patch_size
        self.vision_hidden = tower_cfg.hidden_size
        self.grid_side = grid_side(self.image_size, self.patch_size)
        counts = grid_and_token_count(self.image_size, self.patch_size, config.shuffle_factor, config.grid_policy)
        self.tokens_per_image = counts["tokens_per_image"]

        if config.freeze_tower:
            for p in self.tower.parameters():
                p.requires_grad = False
            self.tower.eval()

        proj_in = self.vision_hidden * config.shuffle_factor * config.shuffle_factor
        self.projector = nn.Sequential(
            nn.Linear(proj_in, config.mlp_hidden),
            nn.GELU(),
            nn.Linear(config.mlp_hidden, config.llm_hidden),
        )

    def trainable_parameters(self):
        return self.projector.parameters()

    def train(self, mode: bool = True):
        super().train(mode)
        if self.config.freeze_tower:
            self.tower.eval()  # keep the frozen tower's dropout/etc off regardless of vlm.train()/.eval()
        return self

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        """pixel_values: [B,3,image_size,image_size], already SigLIP-normalized
        (see data.py's preprocess_images/tiny_pixel_values). Returns
        [B, tokens_per_image, llm_hidden]."""
        if self.config.freeze_tower:
            with torch.no_grad():
                patch_tokens = self.tower(pixel_values=pixel_values).last_hidden_state
        else:
            patch_tokens = self.tower(pixel_values=pixel_values).last_hidden_state
        shuffled = pixel_shuffle(patch_tokens, self.grid_side, self.grid_side,
                                  self.config.shuffle_factor, self.config.grid_policy)
        return self.projector(shuffled.to(self.projector[0].weight.dtype))  # tower may run in bf16 outside autocast (eval)
