"""arena_ilaria_adapter.py — lm-evaluation-harness `LM` backend for our own
Ilaria-130M (NXTF v2 + byte-level tokenizer), so it can run the exact same
`lm_eval` tasks as the HF `hf` wrapper runs for the BitNet reference model
(see forge/eval/arena_en.py).

Registers the model type "ilaria" (`@register_model("ilaria")`), loadable via
`lm_eval.evaluator.simple_evaluate(model="ilaria", model_args={...}, ...)` or
by constructing `Ilaria130MLM(...)` directly and passing the instance in as
`model=` (what arena_en.py does).

Design
------
Subclasses `lm_eval.api.model.TemplateLM`, which supplies `loglikelihood()`
(context/continuation tokenization + boundary handling) on top of three
methods this file implements:

  `_loglikelihood_tokens`  — scores (context, continuation) token pairs.
  `loglikelihood_rolling`  — whole-string NLL for perplexity-style tasks,
                              windowed with lm_eval.utils' own
                              get_rolling_token_windows/make_disjoint_window
                              (the same windowing HFLM's loglikelihood_rolling
                              uses) so the two backends can't silently drift
                              on chunking behavior.
  `generate_until`          — greedy decoding (no sampling) that stops at the
                              model's own EOS id or any of the task's `until`
                              strings, whichever comes first.

Everything runs float32 on CUDA (or CPU) via forge/nxtf.py:load_nxtf, which
matches forge/ppl.py's Go-parity convention — no autocast/bf16 anywhere in
this file. Model calls are UNBATCHED (one (context+continuation) sequence
per forward pass): the 130M model is small enough that this is fast, and it
sidesteps right-padding/attention-masking bugs entirely since
IlariaTransformer.forward(ids) takes no attention mask and pays no attention
to anything past its own causal position. `batch_size` is accepted (so
`model_args` strings like `batch_size=1` don't raise) but does not change
this: requests are still scored one at a time.
"""

from __future__ import annotations

import os
import sys
from typing import TYPE_CHECKING

import torch
import torch.nn.functional as F
from tqdm import tqdm

from lm_eval import utils as lm_utils
from lm_eval.api.model import TemplateLM
from lm_eval.api.registry import register_model

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from nxtf import load_nxtf  # noqa: E402
import hf_tokenizer  # noqa: E402

if TYPE_CHECKING:
    from lm_eval.api.instance import Instance


@register_model("ilaria")
class Ilaria130MLM(TemplateLM):
    backend = "causal"

    def __init__(
        self,
        brain_dir: str = "data/forge/brain-a",
        device: str | None = None,
        max_gen_toks: int = 256,
        batch_size: int | str = 1,
        max_batch_size: int | None = None,  # accepted, unused (see module docstring)
        **kwargs,
    ) -> None:
        super().__init__()
        self._device = torch.device(device) if device else torch.device("cuda" if torch.cuda.is_available() else "cpu")
        nxtf_path = os.path.join(brain_dir, "transformer.nxtf")
        tok_path = os.path.join(brain_dir, "tokenizer.json")
        self.model = load_nxtf(nxtf_path, device=str(self._device))
        self.model.eval()
        # load_nxtf only ever copies float32 data into float32-initialized
        # parameters (nxtf.py:load_nxtf) — assert instead of silently
        # running in some other dtype, matching forge/ppl.py's own check.
        assert next(self.model.parameters()).dtype == torch.float32, "Ilaria130MLM requires float32 (Go-parity) weights"
        self.tok = hf_tokenizer.load(tok_path)

        self._eot_token_id = int(self.model.cfg.eos_token_id)
        self._max_length = int(self.model.cfg.max_seq_len)
        self._max_gen_toks = int(max_gen_toks)
        self._batch_size = batch_size

    # -- TemplateLM required interface --------------------------------

    @property
    def eot_token_id(self) -> int:
        return self._eot_token_id

    @property
    def max_length(self) -> int:
        return self._max_length

    @property
    def max_gen_toks(self) -> int:
        return self._max_gen_toks

    def tok_encode(self, string: str, add_special_tokens: bool | None = None, **kwargs) -> list[int]:
        return self.tok.encode(string, add_special_tokens=False).ids

    def tok_decode(self, tokens) -> str:
        return self.tok.decode(list(tokens), skip_special_tokens=False)

    # -- scoring --------------------------------------------------------

    def _forward_logits(self, ids: list[int]) -> torch.Tensor:
        """One forward pass over a single sequence. Returns float32 logits
        [T, V]."""
        x = torch.tensor([ids], dtype=torch.long, device=self._device)
        with torch.no_grad():
            logits = self.model(x)[0]
        return logits.float()

    def _loglikelihood_tokens(
        self,
        requests: list[tuple[tuple[str, str], list[int], list[int]]],
        disable_tqdm: bool = False,
        **kwargs,
    ) -> list[tuple[float, bool]]:
        res: list[tuple[float, bool]] = []
        for _, context_enc, continuation_enc in tqdm(
            requests, disable=disable_tqdm, desc="loglikelihood (ilaria130m)"
        ):
            assert len(context_enc) > 0, "context_enc must be non-empty"
            assert len(continuation_enc) > 0, "continuation_enc must be non-empty"
            assert len(continuation_enc) <= self._max_length, "continuation longer than the model's max_seq_len"
            # Truncate from the left when context+continuation overflows the
            # model's window — same rule HFLM._loglikelihood_tokens uses.
            whole = (context_enc + continuation_enc)[-(self._max_length + 1):]
            contlen = len(continuation_enc)
            inp = whole[:-1]
            logits = self._forward_logits(inp)  # [len(inp), V]
            log_probs = F.log_softmax(logits, dim=-1)
            cont_logp = log_probs[-contlen:]  # continuation is always the tail
            cont_ids = whole[-contlen:]
            cont_ids_t = torch.tensor(cont_ids, dtype=torch.long, device=self._device)
            greedy_ids = cont_logp.argmax(dim=-1)
            is_greedy = bool(torch.equal(greedy_ids, cont_ids_t))
            logp = float(cont_logp[torch.arange(contlen), cont_ids_t].sum())
            res.append((logp, is_greedy))
        return res

    def loglikelihood_rolling(self, requests: list["Instance"], disable_tqdm: bool = False) -> list[float]:
        out: list[float] = []
        for (string,) in tqdm(
            [req.args for req in requests], disable=disable_tqdm, desc="loglikelihood_rolling (ilaria130m)"
        ):
            token_list = self.tok_encode(string)
            windows = [
                lm_utils.make_disjoint_window(w)
                for w in lm_utils.get_rolling_token_windows(
                    token_list=token_list,
                    prefix_token=self.eot_token_id,
                    max_seq_len=self._max_length,
                    context_len=1,
                )
            ]
            pseudo_reqs = [(None, a, b) for a, b in windows]
            window_results = self._loglikelihood_tokens(pseudo_reqs, disable_tqdm=True)
            total = sum(nll for nll, _ in window_results)
            out.append(total)
            self.cache_hook.add_partial("loglikelihood_rolling", (string,), total)
        return out

    # -- generation -------------------------------------------------------

    def generate_until(self, requests: list["Instance"], disable_tqdm: bool = False) -> list[str]:
        res: list[str] = []
        for context, gen_kwargs in tqdm(
            [req.args for req in requests], disable=disable_tqdm, desc="generate_until (ilaria130m)"
        ):
            gen_kwargs = dict(gen_kwargs or {})
            until = gen_kwargs.get("until") or []
            if isinstance(until, str):
                until = [until]
            max_new = int(gen_kwargs.get("max_gen_toks", self._max_gen_toks))
            text = self._generate_greedy_until(self.tok_encode(context), until, max_new)
            res.append(text)
            self.cache_hook.add_partial("generate_until", (context, gen_kwargs), text)
        return res

    @torch.no_grad()
    def _generate_greedy_until(self, context_ids: list[int], until: list[str], max_new: int) -> str:
        ids = list(context_ids)
        start = len(ids)
        for _ in range(max_new):
            ctx = ids[-self._max_length:]
            logits = self._forward_logits(ctx)[-1]
            nxt = int(torch.argmax(logits))
            ids.append(nxt)
            eos_hit = nxt == self._eot_token_id
            gen_ids = ids[start: len(ids) - (1 if eos_hit else 0)]
            text = self.tok_decode(gen_ids)
            cut = min((i for i in (text.find(s) for s in until) if i != -1), default=None)
            if cut is not None:
                return text[:cut]
            if eos_hit:
                return text
        return self.tok_decode(ids[start:])
