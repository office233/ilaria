"""forge/multimodal/mm_model.py -- BitNetVLM: frozen BitNet LLM + a trainable
VisionAdapter (see vision_adapter.py), spliced together the LLaVA way.

Chat template (task spec, matching cortex.Llama3ChatPrompt's semantics in
cortex/tokenizer_llama3.go and tokenizer_config.json's chat_template -- see
that file's own docstring):

    "User: {content}<|eot_id|>Assistant: {answer}<|eot_id|>"

For a multimodal turn, {content} is the user's text with an IMAGE_TOKEN
("<image>") marker somewhere inside it (data.py's samples always include
one). BitNetVLM:

  1. splits {content} into the text before/after the marker,
  2. tokenizes "User: " + before, and after + "<|eot_id|>Assistant: ",
     each with the real tokenizer (add_special_tokens=False -- the template
     above never adds a bos_token, matching Llama3ChatPrompt, which does not
     either; see forge/llama3_tokenizer_reference.py's `chat` subcommand for
     the validated one-shot-tokenize-the-rendered-string reference this
     mirrors as closely as splicing an image allows),
  3. looks up those ids' embeddings via `model.get_input_embeddings()`,
  4. runs the projected image tokens through the SAME embedding table's
     hidden size (VisionAdapter already projects to llm_hidden) and
     concatenates: [before_emb, image_emb, after_emb, answer_emb],
  5. builds labels = [-100]*(everything up to and including the prompt) +
     answer_ids, so the LM loss (out.loss from a standard HF CausalLM
     forward with `labels=`) is computed on the answer tokens only.

Splitting text around the image marker and tokenizing the pieces separately
(step 2) can in principle land on slightly different BPE merges at the
split boundary than tokenizing the whole string in one call would -- this
is an accepted limitation shared by every LLaVA-style implementation that
splices image embeddings into a text token stream (there is no way to tokenize
"through" an embedded image), not something specific to this code.

The LLM's parameters are frozen (`requires_grad=False`) but its forward is
NOT wrapped in `torch.no_grad()`: gradients must still flow back through it
into the image embeddings so the projector (which sits before the LLM in the
graph) receives a gradient. This is the opposite of VisionAdapter's own
frozen tower, which IS wrapped in `torch.no_grad()` there, because nothing
trainable sits upstream of it.
"""

from __future__ import annotations

import os

# See forge/bitnet_reference.py's module docstring / train_stage1.py's own
# copy of this line: must be set before torch is imported anywhere in the
# process, so it is set here too in case this module is ever imported
# before train_stage1.py sets it.
os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")

import sys  # noqa: E402

import torch  # noqa: E402
import torch.nn as nn

IMAGE_PLACEHOLDER = "<image>"


def pad_and_stack(samples: list):
    """samples: list of (inputs_embeds [T_i, H], labels [T_i]) -> right-padded
    (inputs_embeds [B, T_max, H], labels [B, T_max] filled with -100,
    attention_mask [B, T_max])."""
    max_len = max(e.shape[0] for e, _ in samples)
    hidden = samples[0][0].shape[1]
    device = samples[0][0].device
    dtype = samples[0][0].dtype
    b = len(samples)
    embeds = torch.zeros(b, max_len, hidden, dtype=dtype, device=device)
    labels = torch.full((b, max_len), -100, dtype=torch.long, device=device)
    attn = torch.zeros(b, max_len, dtype=torch.long, device=device)
    for i, (e, lab) in enumerate(samples):
        n = e.shape[0]
        embeds[i, :n] = e
        labels[i, :n] = lab
        attn[i, :n] = 1
    return embeds, labels, attn


class BitNetVLM(nn.Module):
    def __init__(self, llm, tokenizer, vision_adapter, max_text_len: int = 256):
        super().__init__()
        self.llm = llm
        self.tokenizer = tokenizer
        self.vision_adapter = vision_adapter
        self.max_text_len = max_text_len

        for p in self.llm.parameters():
            p.requires_grad = False
        self.llm.eval()
        self.embed_tokens = self.llm.get_input_embeddings()

        eot = tokenizer.convert_tokens_to_ids("<|eot_id|>")
        self.eot_id = eot if isinstance(eot, int) and eot >= 0 else tokenizer.eos_token_id

    def train(self, mode: bool = True):
        super().train(mode)
        self.llm.eval()  # always frozen/eval: no dropout drift in a model we never update
        return self

    def _encode_text(self, text: str) -> list:
        if not text:
            return []
        ids = self.tokenizer(text, add_special_tokens=False)["input_ids"]
        return ids[: self.max_text_len]

    def _embed_ids(self, ids: list, like: torch.Tensor) -> torch.Tensor:
        if not ids:
            return like.new_zeros((0, like.shape[-1]))
        idx = torch.tensor(ids, dtype=torch.long, device=like.device)
        return self.embed_tokens(idx)

    def _split_prompt(self, prompt: str) -> tuple:
        if IMAGE_PLACEHOLDER not in prompt:
            prompt = IMAGE_PLACEHOLDER + "\n" + prompt
        before, after = prompt.split(IMAGE_PLACEHOLDER, 1)
        return before, after

    def encode_images(self, pixel_values: torch.Tensor) -> torch.Tensor:
        """pixel_values: [B,3,H,W] -> [B, tokens_per_image, llm_hidden]."""
        return self.vision_adapter(pixel_values)

    def _prefix_embeds(self, prompt: str, img_embeds_i: torch.Tensor) -> torch.Tensor:
        before, after = self._split_prompt(prompt)
        header_ids = self._encode_text(f"User: {before}")
        tail_ids = self._encode_text(after.rstrip() + "<|eot_id|>Assistant: ")
        header_emb = self._embed_ids(header_ids, img_embeds_i)
        tail_emb = self._embed_ids(tail_ids, img_embeds_i)
        return torch.cat([header_emb, img_embeds_i, tail_emb], dim=0)

    def build_sample(self, prompt: str, answer: str, img_embeds_i: torch.Tensor):
        """One (prompt, answer, image) triple -> (inputs_embeds [T,H], labels [T])
        with labels = -100 everywhere except the answer tokens."""
        prefix = self._prefix_embeds(prompt, img_embeds_i)
        answer_ids = self._encode_text(answer.strip() + "<|eot_id|>")
        answer_emb = self._embed_ids(answer_ids, img_embeds_i)
        inputs_embeds = torch.cat([prefix, answer_emb], dim=0)
        labels = torch.tensor([-100] * prefix.shape[0] + answer_ids, dtype=torch.long, device=prefix.device)
        return inputs_embeds, labels

    def forward(self, prompts: list, answers: list, pixel_values: torch.Tensor):
        """prompts/answers: parallel lists of str, one per sample. pixel_values:
        [B,3,H,W] (one image per sample -- stage 1 alignment). Returns
        (loss, logits) from the underlying HF CausalLM forward."""
        img_embeds = self.encode_images(pixel_values)  # [B, N_img, hidden]
        samples = [self.build_sample(p, a, img_embeds[i]) for i, (p, a) in enumerate(zip(prompts, answers))]
        embeds, labels, attn = pad_and_stack(samples)
        out = self.llm(inputs_embeds=embeds, attention_mask=attn, labels=labels)
        return out.loss, out.logits

    @torch.no_grad()
    def generate_caption(self, pixel_values_1: torch.Tensor, prompt: str = "<image>\nDescribe the image briefly.",
                          max_new_tokens: int = 20) -> str:
        """pixel_values_1: [3,H,W], a single image. Greedy decode via the
        HF `generate()` machinery (KV-cached), seeded with the spliced
        prefix's inputs_embeds -- only the newly generated tokens come back
        when generate() is started from inputs_embeds rather than input_ids."""
        was_training = self.training
        self.eval()
        img = self.encode_images(pixel_values_1.unsqueeze(0))[0]
        # generate() runs outside autocast: inputs_embeds must match the LLM's own dtype (bf16 on Colab).
        prefix = self._prefix_embeds(prompt, img).unsqueeze(0).to(self.llm.get_input_embeddings().weight.dtype)
        attn = torch.ones(prefix.shape[:2], dtype=torch.long, device=prefix.device)
        pad_id = self.tokenizer.pad_token_id
        if pad_id is None:
            pad_id = self.eot_id
        out_ids = self.llm.generate(inputs_embeds=prefix, attention_mask=attn, max_new_tokens=max_new_tokens,
                                     do_sample=False, eos_token_id=self.eot_id, pad_token_id=pad_id)
        if was_training:
            self.train()
        return self.tokenizer.decode(out_ids[0], skip_special_tokens=True)


# ---------------------------------------------------------------------------
# LLM builders
# ---------------------------------------------------------------------------

def load_real_bitnet_llm(hf_dir: str):
    """Loads the real 2.4B offline-quantized microsoft/bitnet-b1.58-2B-4T
    checkpoint, applying the same unmaterialized-weight fix
    forge/bitnet_reference.py uses -- see that module's
    _fix_unmaterialized_offline_weights docstring for why it is needed on
    this transformers version. The LLM stays frozen for the whole of stage
    1 (see BitNetVLM.__init__), so loading it in float32 first (required by
    the fix's numpy round-trip) and letting the caller cast the frozen
    copy to bf16 afterward is fine -- there is no optimizer state riding on
    these weights."""
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    from bitnet_reference import _fix_unmaterialized_offline_weights  # noqa: E402
    from transformers import AutoModelForCausalLM  # noqa: E402

    model = AutoModelForCausalLM.from_pretrained(hf_dir, torch_dtype=torch.float32, low_cpu_mem_usage=True)
    n_fixed = _fix_unmaterialized_offline_weights(model, hf_dir)
    print(f"[mm_model] unpacked {n_fixed} offline AutoBitLinear modules from {hf_dir}")
    model.eval()
    return model


def build_tiny_bitnet_llm(hidden: int, vocab: int, bos_id: int, eos_id: int,
                           layers: int = 2, heads: int = 4, kv_heads: int = 2,
                           ffn: int = 96, max_pos: int = 256):
    """A randomly-initialized, online-quantized BitNet stand-in LLM for
    train_stage1.py --smoke (no checkpoint, no download) -- same
    construction forge/bitnet_reference.py's run_tiny() uses for its
    equivalence-test fixture. `vocab`/`bos_id`/`eos_id` are normally the
    REAL BitNet tokenizer's (already local, no extra download), so the
    smoke path exercises the actual chat-template tokenization end to end;
    only the transformer body (hidden/layers/heads/ffn) is shrunk."""
    from transformers.integrations.bitnet import AutoBitLinear, replace_with_bitnet_linear
    from transformers.models.bitnet.configuration_bitnet import BitNetConfig as HFBitNetConfig
    from transformers.models.bitnet.modeling_bitnet import BitNetForCausalLM

    cfg = HFBitNetConfig(
        vocab_size=vocab, hidden_size=hidden, intermediate_size=ffn,
        num_hidden_layers=layers, num_attention_heads=heads, num_key_value_heads=kv_heads,
        max_position_embeddings=max_pos, rope_theta=10000.0, rms_norm_eps=1e-5,
        tie_word_embeddings=True, attention_bias=False,
        bos_token_id=bos_id, eos_token_id=eos_id,
    )
    model = BitNetForCausalLM(cfg)

    class _QC:
        linear_class = "autobitlinear"
        quantization_mode = "online"
        use_rms_norm = False
        rms_norm_eps = 1e-5

    replace_with_bitnet_linear(model, modules_to_not_convert=["lm_head"], quantization_config=_QC())
    # As in bitnet_reference.run_tiny: replace_with_bitnet_linear builds the
    # new AutoBitLinear modules on the meta device (designed for a
    # from_pretrained load that materializes them afterward); since there is
    # no checkpoint here, materialize real random weights before any forward.
    for mod in model.modules():
        if isinstance(mod, AutoBitLinear):
            w = torch.empty(mod.weight.shape, dtype=torch.float32)
            w.normal_(mean=0.0, std=1.0)
            mod.weight = torch.nn.Parameter(w, requires_grad=False)
    model.eval()
    return model, cfg
