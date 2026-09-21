# Ghid Execuție pe Google Colab Pro (NVIDIA H100 80GB)

Acest ghid descrie pas cu pas cum să folosești unitățile de pe **Google Colab Pro** cu GPU **NVIDIA H100 PCIe / SXM (80 GB VRAM)** pentru a antrena creierul **Ilaria (Broca 2.0)** din Nexus Cortex.

---

## 1. Configurarea Mediului în Google Colab

1. Intră pe [Google Colab](https://colab.research.google.com/).
2. Creează un Notebook nou (`File` -> `New notebook`).
3. Deschide setările de hardware: **Runtime** -> **Change runtime type**.
4. Selectează:
   - **Hardware accelerator**: `GPU`
   - **GPU type**: `H100` (disponibil pe planul Pro / Pro+ cu unități de calcul)
5. Apasă **Save**.

Verifică disponibilitatea H100 rulând în prima celulă:
```bash
!nvidia-smi
```
Ar trebui să vezi `NVIDIA H100 80GB HBM3` cu ~80.000 MiB VRAM liber.

---

## 2. Instalare Dependențe și Clonare Proiect

În a doua celulă din Colab:

```bash
# 1. Dependențe Python pentru H100
!pip install --upgrade torch torchvision torchaudio datasets transformers accelerate

# 2. Instalare Go (necesar pentru binarul de tokenizare ultrarapidă)
!apt-get update -qq && apt-get install -y golang-go

# 3. Clonează proiectul tău sau încarcă folderul
# Dacă ai repo GitHub:
# !git clone https://github.com/office233/Nexuscortex.git /content/nexus
# %cd /content/nexus

# Sau dacă încarci o arhivă zip din PC:
# from google.colab import files
# files.upload() # încarcă nexus.zip
# !unzip -q nexus.zip -d /content/nexus
# %cd /content/nexus
```

---

## 3. Pregătirea Corpusului (TinyStories + Wikipedia Română)

Rulează scriptul de descărcare și formatare direct din Colab (conexiunea de 1 Gbps a Colab descarcă TinyStories în sub 2 minute):

```bash
# Descarcă 300k mostre TinyStories și 100k paragrafe Wikipedia RO
!python forge/prepare_corpus.py \
  --out-dir ./data/corpus \
  --tinystories \
  --wiki-ro \
  --max-tinystories 300000 \
  --max-wiki-ro 100000 \
  --merge
```
Rezultatul va fi în `./data/corpus/all.jsonl`.

---

## 4. Tokenizarea Corpusului

Transformă textul brut într-un stream binar optimizat pentru memmap:

```bash
# Compilare tool tokenizare Go
!go build -o /content/corpus-tokenize ./cmd/corpus-tokenize

# Tokenizare (folosind tokenizerul BPE / GPT-2 existent din proiect)
!/content/corpus-tokenize \
  -tokenizer ./data/tokenizer.json \
  -in ./data/corpus/all.jsonl \
  -out ./data/corpus/train_stream
```
Aceasta creează `train_stream.bin` și `train_stream.json`.

---

## 5. Antrenarea pe H100 (Rețetele de Aur)

### Opțiunea A: Model 30M (Rapid & Coerent — Recomandat pentru primul test, ~45-60 min)
- **Dimensiuni**: 6 straturi, d_model 384, 6 capete, FFN 1536
- **Context**: 1024 tokeni
- **Batch efectiv**: 128 micro-batch × 4 acumulări = **512 secvențe / pas** (peste 500.000 tokeni per actualizare!)
- **Tehnologii H100**: `bf16` nativ, `torch.compile`, `TF32`, `RoPE`, `SwiGLU`

```bash
!python forge/train_ilaria.py \
  --data ./data/corpus/train_stream \
  --out /content/brain-30m \
  --embed-dim 384 \
  --heads 6 \
  --layers 6 \
  --ffn-dim 1536 \
  --ctx 1024 \
  --max-seq-len 1024 \
  --rope \
  --swiglu \
  --dropout 0.1 \
  --batch 128 \
  --accum 4 \
  --steps 20000 \
  --warmup 1000 \
  --lr 6e-4 \
  --min-lr 6e-5 \
  --wd 0.1 \
  --precision bf16 \
  --compile \
  --eval-every 500 \
  --seed 42
```

---

### Opțiunea B: Model 150M (Capacitate Mare & Cunoștințe Dense, ~3-4 ore)
- **Dimensiuni**: 12 straturi, d_model 768, 12 capete, FFN 3072
- **Context**: 1024 tokeni (extensibil la 2048)
- **Batch efectiv**: 128 micro-batch × 4 acumulări = 512 secvențe / pas

```bash
!python forge/train_ilaria.py \
  --data ./data/corpus/train_stream \
  --out /content/brain-150m \
  --embed-dim 768 \
  --heads 12 \
  --layers 12 \
  --ffn-dim 3072 \
  --ctx 1024 \
  --max-seq-len 1024 \
  --rope \
  --swiglu \
  --dropout 0.05 \
  --batch 128 \
  --accum 4 \
  --steps 40000 \
  --warmup 2000 \
  --lr 4e-4 \
  --min-lr 4e-5 \
  --wd 0.1 \
  --precision bf16 \
  --compile \
  --grad-checkpoint \
  --eval-every 1000 \
  --seed 42
```

---

## 6. Descărcarea Noului Creier pe Calculatorul Local

Când antrenarea atinge cel mai bun `val_loss`, scriptul exportă automat fișierul binar compact `transformer.nxtf`.

Pentru a-l descărca din Colab pe PC:
```python
from google.colab import files

# Descărcare creier antrenat
files.download('/content/brain-30m/transformer.nxtf')

# Descărcare log de antrenament
files.download('/content/brain-30m/training.log')
```

---

## 7. Rularea Noului Creier în Nexus Cortex pe PC

Plasează fișierul `transformer.nxtf` descărcat în folderul de date din Nexus Cortex, de exemplu:
`d:\nexus\data\forge\brain-v1\transformer.nxtf`

Apoi testează-l instantaneu:
```powershell
# Testare generare directă cu accelerare GPU locală:
go run -tags gpu ./cmd/nxtf-run -data-dir ./data/forge/brain-v1 -gpu -prompt "Once upon a time"

# Sau în organismul complet (cu Hippocampus + CognitiveBridge):
go run ./cmd/cortex -data-dir ./data/forge/brain-v1
```

Organismul va beneficia automat de:
1. **Limbaj fluent și coerent** învățat pe H100 din TinyStories & Wikipedia.
2. **Memorie continuă instantanee (one-shot)** asigurată de Hippocampus și CognitiveBridge pe PC-ul local.
