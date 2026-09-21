"""make_colab_notebook.py — build the self-contained Colab notebook for phase 1.

The notebook embeds the forge Python files as a base64 zip cell, so a Colab
session needs neither the Git repo nor a Go toolchain: the tokenizer is trained
with HuggingFace `tokenizers` (byte-level BPE, verified id-for-id identical to
the Go engine's byte-level mode) and the corpus is tokenized in Python.

    python forge/make_colab_notebook.py forge/ilaria_phase1.ipynb
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DRIVE = "/content/drive/MyDrive/ilaria"
EMBED = ["ilaria_model.py", "nxtf.py", "train_ilaria.py", "prepare_corpus.py", "concat_streams.py", "hf_tokenizer.py"]


def code(src):
    return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": src}


def md(src):
    return {"cell_type": "markdown", "metadata": {}, "source": src}


def build():
    cells = [
        md("# Ilaria — Faza 1 (corpus → tokenizare → antrenare pe H100)\n\n"
           "Notebook autonom: codul e înglobat în celulele `%%writefile`, tokenizerul se antrenează aici "
           "(byte-level BPE, identic cu modul byte-level al motorului Go), corpusul se tokenizează în Python. "
           "Celulele 1–6 merg pe o sesiune **fără GPU**; 7–8 pe **H100**. Totul se scrie pe Drive în `MyDrive/ilaria`; "
           "o sesiune întreruptă se reia de unde a rămas. Celulele lungi folosesc `%%shell`, deci afișează progresul în timp real."),
        code("from google.colab import drive\ndrive.mount('/content/drive')"),
        code("import os\n"
             "os.makedirs('/content/nexus/forge', exist_ok=True)\n"
             f"os.makedirs('{DRIVE}/corpus', exist_ok=True); os.makedirs('{DRIVE}/brain-a', exist_ok=True)\n"
             "%pip -q install datasets tokenizers\n"
             "print('ok')"),
    ]
    # The six forge files travel inside the notebook as one deflated zip
    # (base64), which keeps the .ipynb small and the cell count low.
    import base64
    import io
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in EMBED:
            with open(os.path.join(HERE, name), "rb") as f:
                z.writestr(name, f.read())
    payload = base64.b64encode(buf.getvalue()).decode("ascii")
    cells.append(code("import base64, io, zipfile\n"
                      f"SRC = \"{payload}\"\n"
                      "zipfile.ZipFile(io.BytesIO(base64.b64decode(SRC))).extractall('/content/nexus/forge')\n"
                      "import os; print(sorted(os.listdir('/content/nexus/forge')))"))
    cells += [
        md("## Tokenizer (5–10 min): eșantion RO/EN de 220 MB din HuggingFace → BPE byte-level 32k\n\n"
           "Sare dacă `tokenizer.json` există deja în Drive."),
        code("%%shell\n"
             "cd /content/nexus\n"
             f"if [ -s {DRIVE}/tokenizer.json ]; then echo 'tokenizer exists'; exit 0; fi\n"
             "python -u forge/prepare_corpus.py --tokenizer-sample /content/tokenizer_sample.txt --sample-bytes 220000000 \\\n"
             "  --sources wiki_ro,fineweb2_ro,tinystories,fineweb_edu --max wiki_ro=100000 --max tinystories=80000 2>&1 | grep --line-buffered -v Warning\n"
             f"python forge/hf_tokenizer.py train --input /content/tokenizer_sample.txt --vocab 32000 --out {DRIVE}/tokenizer.json\n"
             f"ls -la {DRIVE}/tokenizer.json {DRIVE}/tokenizer.hf.json"),
        md("## Corpus pe Drive (1–3 ore, reluabil)\n\n"
           "FineWeb-2 românesc (3 M documente), FineWeb-Edu (2 M), Wikipedia RO (300 k) și EN (500 k) ≈ 4 miliarde de tokeni."),
        code("%%shell\n"
             "cd /content/nexus\n"
             f"python -u forge/prepare_corpus.py --out-dir {DRIVE}/corpus \\\n"
             "  --sources wiki_ro,wiki_en,fineweb2_ro,fineweb_edu \\\n"
             "  --max wiki_ro=300000 --max wiki_en=500000 --max fineweb2_ro=3000000 --max fineweb_edu=2000000 2>&1 | grep --line-buffered -v Warning\n"
             f"ls {DRIVE}/corpus | head -60; du -sh {DRIVE}/corpus"),
        md("## Tokenizare (8 procese) + stream unic\n\nSare peste shard-urile care au deja meta `.json` (scris la final, deci un `.bin` parțial se reface)."),
        code("%%shell\n"
             "cd /content/nexus\n"
             f"for f in {DRIVE}/corpus/*.jsonl; do p=\"${{f%.jsonl}}\"; [ -s \"$p.json\" ] || echo \"$p\"; done \\\n"
             f"  | xargs -P \"$(nproc)\" -I{{}} python forge/hf_tokenizer.py encode --tokenizer {DRIVE}/tokenizer.json --in {{}}.jsonl --out {{}}\n"
             f"python forge/concat_streams.py --out {DRIVE}/train_stream \\\n"
             f"  --prefix ro={DRIVE}/corpus/fineweb2_ro --prefix ro={DRIVE}/corpus/wiki_ro \\\n"
             f"  --prefix en={DRIVE}/corpus/fineweb_edu --prefix en={DRIVE}/corpus/wiki_en\n"
             f"cat {DRIVE}/train_stream.json"),
        md("## (H100) Viteza: 100 de pași cu rețeta A\n\nRuntime → H100, apoi rulează din nou celulele de sus (montare, instalare, `%%writefile`), apoi aceasta."),
        code("%%shell\n"
             "cd /content/nexus\n"
             f"python -u forge/train_ilaria.py --data {DRIVE}/train_stream --out /content/speedtest \\\n"
             "  --embed-dim 768 --heads 12 --layers 12 --ffn-dim 2688 --ctx 1024 --max-seq-len 1024 --rope --swiglu --dropout 0 \\\n"
             "  --batch 64 --accum 4 --steps 100 --warmup 20 --lr 6e-4 --min-lr 6e-5 --wd 0.1 --precision bf16 --compile --eval-every 100 2>&1"),
        md("## (H100) Rețeta A — Ilaria-130M, până la 3 G tokeni\n\nCheckpoint pe Drive la fiecare 500 de pași; dacă sesiunea cade, rulează din nou celula: reia din `checkpoint.pt`."),
        code("%%shell\n"
             "cd /content/nexus\n"
             f"TOK=$(python -c \"import json;print(json.load(open('{DRIVE}/train_stream.json'))['tokens'])\")\n"
             "STEPS=$(( TOK / 262144 )); [ $STEPS -gt 11500 ] && STEPS=11500\n"
             "echo \"tokens=$TOK steps=$STEPS\"\n"
             f"RESUME=\"\"; [ -f {DRIVE}/brain-a/checkpoint.pt ] && RESUME=\"--resume {DRIVE}/brain-a/checkpoint.pt\"\n"
             f"python -u forge/train_ilaria.py --data {DRIVE}/train_stream --out {DRIVE}/brain-a \\\n"
             "  --embed-dim 768 --heads 12 --layers 12 --ffn-dim 2688 --ctx 1024 --max-seq-len 1024 --rope --swiglu --dropout 0 \\\n"
             "  --batch 64 --accum 4 --steps $STEPS --warmup 500 --lr 6e-4 --min-lr 6e-5 --wd 0.1 --precision bf16 --compile --eval-every 500 $RESUME"),
        md("## Rezultatul\n\n"
           f"`{DRIVE}/brain-a/transformer.nxtf` + `tokenizer.json` → pe PC în `data/forge/brain-a/`, apoi "
           "`go run -tags gpu ./cmd/nxtf-run -data-dir ./data/forge/brain-a -gpu -prompt \"Ștefan cel Mare a fost\"`."),
    ]
    return {"cells": cells,
            "metadata": {"kernelspec": {"display_name": "Python 3", "name": "python3"}, "language_info": {"name": "python"},
                         "colab": {"name": "ilaria_phase1.ipynb", "provenance": []}},
            "nbformat": 4, "nbformat_minor": 0}


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "ilaria_phase1.ipynb")
    nb = build()
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(nb, f, ensure_ascii=False, indent=1)
    size = os.path.getsize(out)
    print(f"wrote {out}: {len(nb['cells'])} cells, {size/1024:.0f} KB")
