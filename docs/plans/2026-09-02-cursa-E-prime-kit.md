# Cursa E′ — kit de lansare

**Scop**: primul model antrenat de la zero cu TOATĂ arhitectura modernă
construită pe 2 septembrie 2026. Diferența față de cursele C/D nu mai e o
singură variabilă — e întreaga generație de unelte:

| Aspect | Cursa C/D | Cursa E′ |
|---|---|---|
| Parametri | 5,4M | ~30M (6L × d384 × 6H, FFN 1536) |
| Poziții | absolute învățate, zid la 512 | **RoPE**, ctx 1024 |
| FFN | GELU | **SwiGLU** |
| Regularizare | ZERO | **dropout 0.1 + AdamW 0.01** |
| Batch | 1, medie pe secvențe | **8, medie pe TOKENI** |
| Sampling eval | temp+top-k | **top-p + repetition penalty** |
| Scorer | v1 (false-positive documentate) | **v2** (answer-aware, word-boundary) |
| Tokenizer nou | ore (O(merges×corpus)) | **minute** (incremental, 17,4× măsurat) |
| Checkpoint | gzip-JSON lent | **binar NXTF2BIN** |
| Corpus | dolly+alpaca (67,8% sub 25 cuvinte → EOS degenerat) | de decis: TinyStories-style + distilat |

## Config (data/cursa-e-prime.json)

```json
{
  "seed": 42,
  "transformer_embed_dim": 384,
  "transformer_num_heads": 6,
  "transformer_num_layers": 6,
  "transformer_ffn_dim": 1536,
  "transformer_max_seq_len": 1024,
  "transformer_use_rope": true,
  "transformer_use_swiglu": true,
  "transformer_dropout": 0.1,
  "adam_weight_decay": 0.01
}
```

Estimare parametri la vocab 8192: ~30M (embeddings legate 3,1M + blocuri
~26M cu W3). VRAM antrenare (greutăți+gradienti+momenti fp32 + activări):
~1,5–2,5 GB — lejer sub 6 GB.

## Pași

1. **Corpus** (blocajul real; lecția TinyStories):
   - Preferat: TinyStories (HuggingFace `roneneldan/TinyStories`,
     ~1,9 GB text, licență CDLA-Sharing) — poveşti simple, consistente;
     rețeta dovedită pentru coerență la 10–30M parametri.
   - Complement: 10–50k perechi QA distilate prin `cmd/distill`
     (profesor: API sau model local prin llama.cpp pe 1660 Ti).
   - Conversie în JSONL cu câmp "text": `cmd/corpus-convert`.
2. **Tokenizer**: antrenare BPE incremental pe corpusul nou, vocab 8192
   (`cmd/cortex-tokenizer`). Acum durează minute, nu ore.
3. **Lansare**:
   ```
   go build -tags gpu -o bin/cortex-broca-train.exe ./cmd/cortex-broca-train
   bin/cortex-broca-train.exe -config data/cursa-e-prime.json \
     -data-dir data/cortex-eprime -corpus <corpus.jsonl> \
     -total-steps 40000 -peak-lr 3e-4 -warmup 2000 \
     -auto-eval -eval-history data/cortex-eprime/eval-history.jsonl
   ```
   (batch 8, weight-decay 0.01, dropout 0.1 sunt deja default-uri.)
4. **Țintă**: ppl < 40 pe validare; generare coerentă pe prompturi simple;
   scorer v2 pe evalsuite de la primul pas — fără false-positive.

## Notă hardware

Wall-time estimat: noapte întreagă (12–18h la 40k pași cu batch 8 pe
GTX 1660 Ti prin calea `-tags gpu`). Lansarea cere confirmarea omului —
regula din postmortem-ul cursei D rămâne.
