# Ilaria: predare pentru mutarea pe Azure (25.09.2026)

Document pentru agentul care mută antrenarea de pe Google Colab pe o mașină Azure.
Spune ce există deja, unde se află fiecare fișier și ce rămâne de făcut.
Proiectul se numește **Ilaria** în orice text public. Directorul `D:\nexus` și modulul Go
`nexus-cortex` au rămas cu numele vechi, dar nu se mai folosește „Nexus” în exterior.
Ilaria va fi motorul AI al platformei Swypik.

## 1. Ce este Ilaria, pe scurt

- **Un motor de inferență scris în Go** (`cortex/`, `cmd/`). Rulează modelele local, pe CPU
  sau pe GPU, fără Python.
- **O „forjă” în Python** (`forge/`). Antrenează și exportă modele în formatul NXTF citit de
  motorul Go.
- **Cortexul englez** este BitNet b1.58 2B4T de la Microsoft (licență MIT): un model ternar
  nativ, cu ponderi de 1,58 biți, portat integral în Go.
- **Creierul propriu Ilaria-130M** este un model dens RO+EN antrenat de noi de la zero pe
  3 miliarde de tokeni. Rămâne creierul pentru română și memoria „one-shot”.
- **Simțurile:**
  - ochi: SigLIP2 + proiector în BitNet, stil LLaVA;
  - urechi: encoder Whisper-small + proiector;
  - video: cadre extrase și descrise pe rând;
  - mâini: o buclă de unelte controlată de model.
- **Repo:** https://github.com/office233/ilaria. Este public și ramura principală e `main`.
  Commit-ul curent de la predare: `7e1d50d`.

## 2. Ce s-a făcut (verificat, cu rezultate măsurate)

| Componentă | Stare | Rezultat |
|---|---|---|
| Ilaria-130M (RO+EN, 3,0 mld. tokeni) | antrenat pe Colab, 11 500 pași | ppl de validare 18,1, ppl pe texte Wikipedia din 2025 = 24,4. Go ≡ PyTorch (Δlogit 2e-5) |
| BitNet 2B4T în Go | gata | răspunsuri corecte în chat, tokenizer identic 309/309, echivalență statistică (KL ≤ 0,016) |
| BitNet pe GPU (NVRTC, fără nvcc) | gata | 37–40 tok/s pe GTX 1660 Ti, 2,9 GB VRAM, argmax 100% identic cu CPU |
| Ochi, stage 1 (proiector) | antrenat pe Colab, 2000 pași | descrieri corecte. Exemplu: „In this picture we can see a cat…” |
| Ochi în Go + GPU | gata | turn SigLIP 61 s → 8 s, prefill 134 rânduri 3,6 s, 38 tok/s, `cmd/ilaria-see -gpu -cuda` |
| Video prin cadre | gata | `ilaria-see -video clip.mp4 -frames 6`, rezumat corect pe clipul de test |
| Urechi (Python) | scripturi gata, **neantrenate** | Whisper-small → stivă de 8 cadre → MLP, LibriSpeech, `--smoke` trece |
| Urechi în Go + GPU | gata, fără proiector antrenat | log-mel și encoder ≡ PyTorch (relL2 4,4e-4), GPU 60 s → 17 s, `cmd/ilaria-hear` |
| Mâini (unelte) | gata | `cmd/ilaria-chat`: calc, time, convert, biomed, go_run, read_file. Evaluare: unealta corectă 5/8, apeluri false 0/6, răspunsuri 7/10. 0,7–2,3 s pe prompt |
| Arena EN pentru Ilaria-130M | rulată local | ARC-C 23,5, ARC-E 41,3, HellaSwag 28,5, PIQA 58,3, WinoGrande 53,5, MMLU 24,9 (`docs/benchmarks/arena_en.md`) |
| **Ochi, stage 2 (LoRA instrucțiuni)** | **RULEAZĂ acum pe Colab** | pasul ~5000/6000 la 15:45 ora RO. Loss 1,75 → ~0,85. Răspunde corect la multe întrebări VQA |

Detalii și comenzi exacte sunt în `README.md` și în `docs/research/2026-09-24-ilaria-1.58-multimodal-studiu.md`.

## 3. Ce rulează ACUM pe Colab (nu opriți înainte de final)

- **Cont:** contul Google care deține `MyDrive/ilaria` are Colab Pro+ (în panoul de browser,
  `authuser=2`).
- **Mașina:** GPU „G4” = RTX PRO 6000 Blackwell, 96 GB.
- **Notebook:** `ilaria_phase1_v5.ipynb` din Drive. O celulă rulează `eyes_stage2.sh`.
- **Ritm:** 500 de pași la ~93 min, deci stage 2 se termină azi pe la **19:00 ora RO**.
- **Checkpoint:** `MyDrive/ilaria/stage2_instruct/checkpoint.pt`, 551 MB, salvat la fiecare 500 de pași.
- **Export:** la final, scriptul scrie singur `stage2_instruct/stage2_export.{safetensors,json}`.
- **Coada după stage 2:** următoarea celulă rulează automat `arena_en.sh` (BitNet-2B și
  Ilaria-130M, ~1,5 h), apoi `ears_stage1.sh` (urechi, 2000 de pași).
- **Pe Azure** e suficient să porniți ce n-a apucat Colab să termine. Fiecare script reia
  singur din `checkpoint.pt` dacă fișierul există.

## 4. Unde sunt fișierele (atenție: `data/` NU e în git)

`data/forge/` și `data/pretrained/` sunt în `.gitignore`. Pe mașina nouă trebuie copiate
separat sau regenerate.

| Fișier | Unde | Cum îl obții pe Azure |
|---|---|---|
| **Ilaria-130M**: `transformer.nxtf` (512 MB), `tokenizer.json`, `checkpoint.pt` (1,5 GB) | PC: `data/forge/brain-a/`. Drive: `MyDrive/ilaria/brain-a/` | **copiere obligatorie**, e antrenat de noi |
| **Proiector ochi stage 1**: `adapter_export.{safetensors,json}` (97 MB) | PC: `data/forge/eyes/`. Drive: `MyDrive/ilaria/stage1_projector/` | **copiere obligatorie** |
| **Stage 2**: `checkpoint.pt`, `stage2_export.*` | Drive: `MyDrive/ilaria/stage2_instruct/` | **copiere obligatorie** după final |
| Corpus tokenizat: `train_stream.bin` (7,45 GB, 3,72 mld. tokeni), `tokenizer.json`, `corpus/` | Drive: `MyDrive/ilaria/` | copiere doar dacă se reantrenează creierul RO |
| BitNet 2B4T (HF) | PC: `data/pretrained/bitnet-b1.58-2B-4T` | `snapshot_download("microsoft/bitnet-b1.58-2B-4T")` |
| `bitnet.nxtf` (1,8 GB, pentru Go) | PC: `data/forge/bitnet-2b4t/` | `python forge/import_bitnet.py --hf-dir … --out …` |
| Turn SigLIP2 `siglip2_base.nxtf` | PC: `data/forge/eyes/` | `forge/multimodal/export_tower.py` |
| Encoder Whisper `whisper_small_encoder.nxtf` | PC: `data/forge/ears/` | `forge/multimodal/export_whisper_tower.py` |

Copierea din Drive pe Azure se face cu `rclone` (remote de tip „drive”) sau direct din
Colab către un Azure Blob Storage (`azcopy`). Fișierele de peste 100 MB nu se descarcă prin
browser fără confirmare manuală.

## 5. Capcane cunoscute (au costat ore; nu le repetați)

1. **`huggingface_hub` 2.x strică `transformers`.** Fixați `"huggingface_hub>=1.5,<2"`. Toate
   runner-ele din `forge/colab/` fac deja asta.
2. **IFEval din `lm_eval` cere `langdetect`, `immutabledict` și `nltk`.** Instalați
   `"lm_eval[ifeval]"`. O rulare de 80 de minute s-a pierdut așa. Acum `arena_en.py` salvează
   după fiecare grup de taskuri.
3. **Unele versiuni `transformers` lasă ponderile BitNet împachetate (uint8).**
   `forge/bitnet_reference.py::_fix_unmaterialized_offline_weights` le despachetează. Îl
   apelează deja `mm_model.load_real_bitnet_llm` și `arena_en.py`.
4. **`TORCHDYNAMO_DISABLE=1` e setat în scripturi.** `transformers` decorează operațiile BitNet
   cu `torch.compile`, care cere un compilator C.
5. **Tipuri de date.** Proiectorul e fp32, LLM-ul e bf16. Cast-urile sunt deja puse în
   `vision_adapter.py` și `mm_model.py`.
6. **Căile GPU din Go sunt doar pentru Windows.** `cortex/compute/{nvrtc,cuda_driver,cublas}_dyn.go`
   au tag-ul `gpu && windows` și încarcă DLL-uri. Pe o mașină Linux din Azure, motorul Go
   rulează doar pe CPU până la un port cu `dlopen` pe `libnvrtc.so`, `libcuda.so` și
   `libcublas.so`. Forja Python rulează pe Linux fără modificări, fiindcă și Colab e Linux.
7. **`go test` rulează din directorul pachetului.** Testele pe modele reale primesc căi
   absolute prin variabile de mediu: `NEXUS_BITNET_DIR`, `NEXUS_EARS_DIR`, `NEXUS_BRAIN_DIR`.
8. **Evaluarea cu `lm_eval` pe `bitnet2b` e lentă.** A durat peste 80 de minute pe un GPU de
   96 GB, mai ales IFEval și GSM8K, care sunt generative.

## 6. Ce mai e de făcut (în ordinea priorității)

| # | Sarcină | GPU estimat | Note |
|---|---|---|---|
| 1 | Terminare stage 2, export, test local | 0 (rulează) | `export_stage2.py` scoate `lora.layers.{i}.{proj}.A/B` + proiector |
| 2 | **Încărcarea LoRA în motorul Go** | 0 | Nu există încă. Delta `(α/r)·B(A·x)` se adaugă peste BitLinear, în fp, și nu se poate topi în ternar. Trebuie un kernel CUDA, altfel `ilaria-see` folosește doar proiectorul din stage 1 |
| 3 | Arena EN completă pentru BitNet-2B (referința) + GSM8K/IFEval pentru Ilaria-130M | ~2 h | `forge/colab/arena_en.sh` |
| 4 | Urechi stage 1 | ~8–10 h (estimare, nemăsurat) | `forge/colab/ears_stage1.sh`. Apoi `ilaria-hear -adapter …` local |
| 5 | SFT pentru unelte (function calling) | ~5–10 h | Modelul alege corect unealta 5/8 și greșește argumentele. Setul de evaluare e `cmd/ilaria-chat/testdata/tools_eval.jsonl` |
| 6 | Video și mai multe imagini într-un prompt (LLaVA-Video-178K) | ~30–60 h | după stage 2 |
| 7 | Model mai mare: Ilaria-1B, apoi BitDistill ternar al unui model de 1,7–3B | ≥ 90 h | ținta propunerii EuroHPC |
| 8 | Motor: port GPU pe Linux, CUDA graphs, prefill în loturi | 0 | pentru servirea pe Azure |
| 9 | Integrare: `ilaria-chat` în organism, hipocampul ca unealtă, Swypik | 0 | |

## 7. Azure: ce știm și recomandări

- **Credit:** $5 000 Azure (Microsoft for Startups), expiră pe **20.06.2027**. Mai există $200
  „startup sponsorship”, care expiră pe 22.12.2026.
- **Planul agreat cu utilizatorul:**

  | Destinație | Sumă |
  |---|---|
  | Swypik | ~$1 500 |
  | Antrenare Ilaria | ~$1 800 |
  | Servire Ilaria | ~$700 |
  | Rezervă | ~$1 000 |

- **Cote GPU cerute pe 25.09:**
  - `NDSH100v5`, 96 vCPU (un nod cu 8× H100), în **Spain Central**;
  - GB200 în UK South.

  Cota GPU implicită e 0, așa că așteptați aprobarea.
- **Atenție la cost.** Un nod ND H100 v5 cu 8 GPU-uri costă aproximativ de 8 ori cât un
  singur GPU. Orientativ, la tarif pay-as-you-go este ~$90–100/h. Verificați prețul exact în
  Azure Pricing Calculator pentru regiune.
- **Ce înseamnă pentru buget.** Cei ~$1 800 ajung pentru ~18–20 de ore pe nodul întreg.
  Stage 2 (~15 h pe un GPU de 96 GB) sau urechile nu au nevoie de 8 GPU-uri. Pentru ele, o
  mașină cu **un singur H100 sau A100 de 80 GB** dă de 5–10 ori mai multe ore pe același ban.
  Exemple: familia NCads H100 v5 sau NC A100 v4, cu cotă cerută separat.
- **Spot VM** e mult mai ieftin, dar poate fi oprit oricând. Scripturile noastre reiau din
  `checkpoint.pt`, așa că spot e utilizabil pentru antrenare.
- **Opriți mașina când nu antrenează**, cu deallocate, nu doar shutdown din sistemul de
  operare. Altfel se facturează în continuare.
- **Setup minim pe un VM Ubuntu:**
  1. Driver NVIDIA și CUDA, sau o imagine „Data Science VM”.
  2. `python3 -m venv`.
  3. `pip install torch transformers datasets tokenizers safetensors "huggingface_hub>=1.5,<2" "lm_eval[ifeval]" torchaudio soundfile`.
  4. `git clone https://github.com/office233/ilaria`.
  5. Copierea fișierelor din secțiunea 4.
  6. Rularea runner-elor din `forge/colab/` cu variabila `D` setată la directorul local, în
     loc de `/content/drive/MyDrive/ilaria`.

## 8. Reguli de lucru în acest repo

- **Citiți `AGENTS.md`.** Utilizatorul a autorizat explicit `git push` pe `main`, începând cu
  24.09.2026. Commit-urile se fac mici, cu gate-ul rulat înainte:
  - `go vet ./...`;
  - `go build ./...`;
  - testele relevante;
  - pentru Python, `pytest forge/multimodal/tests` și `--smoke`.
- **Nu se raportează „gata” pe cuvântul unui sub-agent.** Gate-ul se rulează de cel care
  raportează.
- **Nu se forțează căi ocolitoare** când un clasificator de siguranță blochează o acțiune
  (de exemplu, ambalarea codului în base64 pe Drive). Se cere acordul utilizatorului.
- **Nu se introduc credențiale.** Popup-urile OAuth, cum e montarea Drive în Colab, le apasă
  utilizatorul.
