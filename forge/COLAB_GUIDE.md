# Faza 1 pe Google Colab (H100 94 GB) — cortexul de limbaj al Ilariei

> **Actualizare 2026-09-21 (după-amiază): calea folosită efectiv este notebook-ul autonom
> `forge/ilaria_phase1.ipynb`** (generat de `forge/make_colab_notebook.py`, urcat în Drive și rulat din Colab).
> Motive: contul GitHub e suspendat (Colab nu poate clona repo-ul), iar încărcarea de fișiere prin browser nu e
> posibilă din sesiunea automată. Notebook-ul poartă codul `forge/` ca zip base64, nu are nevoie de Go în Colab,
> iar tokenizerul se antrenează acolo cu `tokenizers` (byte-level BPE 32k, `forge/hf_tokenizer.py`), verificat
> id-cu-id identic cu modul byte-level al motorului Go (`cmd/tok-encode`, 306 linii, 0 diferențe). Ghidul de mai
> jos rămâne valabil ca referință pentru varianta manuală cu Go.

Scop: un model dens RO+EN antrenat de la zero pe H100, exportat în `transformer.nxtf`,
care rulează în motorul Go de pe PC (GTX 1660 Ti) lângă hipocamp, puntea cognitivă și
organele (biomed, sandbox). Corpusul, shard-urile tokenizate și checkpoint-urile stau pe
Google Drive (15 TB), deci o sesiune Colab întreruptă se reia de unde a rămas.

Regula de aur: **măsurăm înainte să promitem**. Pasul 5 rulează 100 de pași și citește
tok/s real; abia apoi alegem rețeta și numărul de pași.

---

## 0. Ce se face pe PC, o singură dată

Tokenizerul se antrenează local (Go), pe un eșantion echilibrat RO/EN de ~200 MB:

```bash
python forge/prepare_corpus.py --tokenizer-sample data/corpus/tokenizer_sample.txt --sample-bytes 220000000 --sources wiki_ro,fineweb2_ro,tinystories,fineweb_edu --max wiki_ro=100000 --max tinystories=80000
```

```bash
go run ./cmd/cortex-tokenizer -train -input data/corpus/tokenizer_sample.txt -vocab-size 32000 -output data/tokenizer-ro-en-32k.json
```

Fișierul `data/tokenizer-ro-en-32k.json` se urcă în Drive (`MyDrive/ilaria/tokenizer.json`).
Măsurat pe 2026-09-21 (eșantion 220 MB, 54 080 documente RO + 54 080 EN, antrenare 1 min 54 s), pe text
nevăzut: română 1,67 tokeni/cuvânt (tokenizerul vechi de 8k: 3,11), engleză 1,22 (vechi: 1,40), 0 % `<UNK>`,
round-trip exact inclusiv pe „ghilimele” și cuvinte-cu-cratimă (pre-tokenizer v2, câmpul `pretok: 2`).
Vocabularul e char-level BPE cu 5 tokeni speciali (`<PAD> <UNK> <BOS> <EOS> <SEP>`);
`corpus-tokenize` separă documentele cu `<EOS>` și scrie stream-ul ca `uint16`.

---

## 1. Runtime Colab

`Runtime → Change runtime type → GPU: H100`. Prima celulă:

```bash
!nvidia-smi --query-gpu=name,memory.total --format=csv
```

```python
from google.colab import drive
drive.mount('/content/drive')
```

```bash
%cd /content
!git clone https://github.com/office233/Nexuscortex.git nexus
%cd /content/nexus
!pip -q install datasets
# Go: pachetul apt e prea vechi pentru go.mod (1.26); luăm binarul oficial.
!wget -q https://go.dev/dl/go1.26.2.linux-amd64.tar.gz && rm -rf /usr/local/go && tar -C /usr/local -xzf go1.26.2.linux-amd64.tar.gz
import os; os.environ["PATH"] = "/usr/local/go/bin:" + os.environ["PATH"]
!go version
!mkdir -p /content/drive/MyDrive/ilaria/corpus /content/drive/MyDrive/ilaria/brain-a /content/drive/MyDrive/ilaria/brain-b
```

Opțional, un `HF_TOKEN` (Settings → Secrets) accelerează descărcările de pe HuggingFace.

---

## 2. Corpusul pe Drive (reluabil)

Surse și ținte (≈ 4 miliarde de tokeni în total; câte un shard JSONL la 50 000 de documente):

| sursă | limbă | documente | ≈ tokeni |
|---|---|---|---|
| `fineweb2_ro` (FineWeb-2, web românesc filtrat) | ro | 3 000 000 | 2,1 G |
| `fineweb_edu` (FineWeb-Edu, web educațional) | en | 2 000 000 | 1,4 G |
| `wiki_ro` (Wikipedia RO, bucăți de ~600 caractere) | ro | 300 000 | 0,05 G |
| `wiki_en` (Wikipedia EN) | en | 500 000 | 0,1 G |

```bash
!python forge/prepare_corpus.py --out-dir /content/drive/MyDrive/ilaria/corpus \
   --sources fineweb2_ro,fineweb_edu,wiki_ro,wiki_en \
   --max fineweb2_ro=3000000 --max fineweb_edu=2000000 --max wiki_ro=300000 --max wiki_en=500000
```

Durează 1–3 ore (depinde de HF). Dacă sesiunea cade, aceeași comandă sare peste shard-urile
marcate complete în `<sursă>.manifest.json` și continuă. Textul e curățat (spații, tabele,
boilerplate web) și tăiat la propoziție la 8 000 de caractere.

---

## 3. Tokenizare + stream unic

```bash
!go build -o /content/corpus-tokenize ./cmd/corpus-tokenize
!cp /content/drive/MyDrive/ilaria/tokenizer.json data/tokenizer.json
!ls /content/drive/MyDrive/ilaria/corpus/*.jsonl | xargs -P 8 -I{} sh -c '/content/corpus-tokenize -tokenizer data/tokenizer.json -in {} -out $(dirname {})/$(basename {} .jsonl)'
```

```bash
!python forge/concat_streams.py --out /content/drive/MyDrive/ilaria/train_stream \
   --prefix ro=/content/drive/MyDrive/ilaria/corpus/fineweb2_ro --prefix ro=/content/drive/MyDrive/ilaria/corpus/wiki_ro \
   --prefix en=/content/drive/MyDrive/ilaria/corpus/fineweb_edu --prefix en=/content/drive/MyDrive/ilaria/corpus/wiki_en
```

Shard-urile RO și EN se intercalează, ca stream-ul să nu înceapă cu 2 GB dintr-o singură sursă.
`train_stream.json` spune câți tokeni sunt: acela e numărul de care depind pașii de mai jos.

---

## 4. Rețetele

| | A — „Ilaria-130M” | B — „Ilaria-340M” |
|---|---|---|
| straturi / d_model / capete / FFN | 12 / 768 / 12 / 2688 | 24 / 1024 / 16 / 2816 |
| context | 1024 | 1024 (2048 dacă tok/s permite) |
| micro-batch × acumulare | 64 × 4 = 262k tokeni/pas | 96 × 4 = 393k tokeni/pas |
| lr / min-lr / warmup | 6e-4 / 6e-5 / 500 | 3e-4 / 3e-5 / 1000 |
| tokeni de antrenare | 3 G (≈ 11 500 pași) | 5 G (≈ 12 700 pași) |
| dropout | 0 (o singură epocă pe corpus mare) | 0 |

Ambele: RoPE, SwiGLU, AdamW wd 0.1, bf16, `torch.compile`. Vocabular 32k, deci
`--max-seq-len` = context. Recomandare: **A întâi** (o sesiune, rezultat sigur), B după ce A
generează română coerentă.

---

## 5. Măsurăm viteza (100 de pași)

```bash
!python forge/train_ilaria.py --data /content/drive/MyDrive/ilaria/train_stream --out /content/speedtest \
   --embed-dim 768 --heads 12 --layers 12 --ffn-dim 2688 --ctx 1024 --max-seq-len 1024 --rope --swiglu --dropout 0 \
   --batch 64 --accum 4 --steps 100 --warmup 20 --lr 6e-4 --min-lr 6e-5 --wd 0.1 --precision bf16 --compile --eval-every 100
```

Citește `tok/s` din log. Pași necesari = tokeni țintă / (batch × accum × ctx); durata = tokeni țintă / tok/s.
Ordine de mărime așteptată pe H100: A 150–250k tok/s (3 G tokeni în 3,5–5,5 h), B 70–110k tok/s
(5 G tokeni în 13–20 h, deci două sesiuni cu `--resume`). Dacă apare OOM, înjumătățește
`--batch` și dublează `--accum` (același număr de tokeni pe pas); pentru B adaugă `--grad-checkpoint`.

---

## 6. Antrenarea (checkpoint pe Drive la fiecare 500 de pași)

Rețeta A:

```bash
!python forge/train_ilaria.py --data /content/drive/MyDrive/ilaria/train_stream --out /content/drive/MyDrive/ilaria/brain-a \
   --embed-dim 768 --heads 12 --layers 12 --ffn-dim 2688 --ctx 1024 --max-seq-len 1024 --rope --swiglu --dropout 0 \
   --batch 64 --accum 4 --steps 11500 --warmup 500 --lr 6e-4 --min-lr 6e-5 --wd 0.1 --precision bf16 --compile --eval-every 500
```

Rețeta B (prima sesiune; a doua adaugă `--resume /content/drive/MyDrive/ilaria/brain-b/checkpoint.pt`):

```bash
!python forge/train_ilaria.py --data /content/drive/MyDrive/ilaria/train_stream --out /content/drive/MyDrive/ilaria/brain-b \
   --embed-dim 1024 --heads 16 --layers 24 --ffn-dim 2816 --ctx 1024 --max-seq-len 1024 --rope --swiglu --dropout 0 \
   --batch 96 --accum 4 --steps 12700 --warmup 1000 --lr 3e-4 --min-lr 3e-5 --wd 0.1 --precision bf16 --compile --eval-every 500
```

La fiecare evaluare scriptul salvează `checkpoint.pt` și, când val_loss scade, `transformer.nxtf`
+ `tokenizer.json` în `--out`. Limita de 24 h a sesiunii nu pierde nimic: reluarea continuă de
la pasul salvat, cu aceeași rată de învățare.

Ce înseamnă „merge”: val_loss coboară monoton, iar mostra greedy de la final e text, nu tokeni
repetați. Perplexitatea așteptată la sfârșit: A ≈ 15–25, B ≈ 10–16 (pe stream mixt RO+EN).

---

## 7. Creierul pe PC

Copiază `transformer.nxtf` și `tokenizer.json` în `data/forge/brain-a/`, apoi:

```bash
go test -count=1 -run TestForgeEquivalence ./cortex/
```

```bash
go run -tags gpu ./cmd/nxtf-run -data-dir ./data/forge/brain-a -gpu -prompt "Ștefan cel Mare a fost"
```

Organismul complet (hipocamp + punte cognitivă + organe) îl încarcă cu `go run ./cmd/cortex -data-dir ./data/forge/brain-a`.

---

## 8. Cost orientativ

Colab facturează H100 la ~12 unități de calcul pe oră (verifică rata curentă în cont).
Rețeta A: 4–6 ore ≈ 50–75 unități. Rețeta B: 13–20 ore ≈ 160–240 unități, în două sesiuni.
Corpusul și tokenizarea rulează pe CPU-ul sesiunii și nu au nevoie de GPU: fă-le într-o
sesiune fără accelerator ca să nu consumi unități.
