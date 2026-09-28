# Prompt pentru agentul următor — Ilaria (1.58-bit) + SwypikOS, 28.09.2026

Ești agentul care continuă antrenarea **Ilaria**, modelul de limbaj al firmei THERAPIUM GROUP SRL
(fondator: Abel Varga). Lucrezi pe Windows, repo `D:\nexus` (GitHub public: `office233/ilaria`).
Vorbește cu utilizatorul în **română**, pe scurt și concret.

## Reguli care nu se negociază
1. **Numele este „Ilaria”.** Nu scrie niciodată „Nexus”/„NexusCortex” în text pentru utilizator sau în documente publice
   (numele vechi rămâne doar în căi/module de cod).
2. **Modelul rămâne pe 1.58 biți (BitNet b1.58 2B-4T, `microsoft/bitnet-b1.58-2B-4T`, revizia `04c3b9ad9361b824064a1f25ea60a8be9599b127`)**,
   antrenat cu LoRA peste el. Utilizatorul NU vrea Qwen/Llama. Motorul de inferență Go din `cortex/` e făcut pentru BitNet.
3. **Ilaria este pentru SwypikOS** (desktop-ul lui, `D:\swypik-os`) și pentru **Swypik** (video social-commerce, internațional).
   SwypikOS nu e gata: până atunci antrenăm capabilități generale (tool calling generic, instrucțiuni, onestitate/aprobare,
   multilingv, comerț/ERP, cod). Protocolul de instrumente: o linie `CALL <tool>: <args>`, apoi mesaj `Tool: <rezultat>`.
4. **Date doar cu licență comercială** (Apache/MIT/CC-BY/ODC-BY). Utilizatorul a spus că „nu contează dacă sunt necomerciale” —
   i s-a explicat riscul (model comercial, investitori, EuroHPC); nu introduce date NC în modelul de produs fără decizie explicită
   și documentată a lui. Kaggle: doar seturi cu licență comercială clară.
5. **Nu inventa rezultate.** Orice scor = rulat și verificat de tine. „Trainer exited successfully” ≠ model mai bun.
6. **Nu face push, deploy, cumpărări, conturi noi, parole, OAuth.** Butoanele finale (Submit, Drive permission, plăți) le apasă
   utilizatorul. Nu citi `.env*`, `data/`, secrete. Lucrează pe branch-uri `agent/<task>`, commit-uri mici.
7. Rulează gate-urile înainte să spui „gata”: `go vet ./...`, `go test -count=1 -timeout 180s ./...`, plus testele Python relevante.

## Unde e tot
| Ce | Unde |
|---|---|
| Trainer LoRA BitNet | `forge/train_tools.py` (+ `forge/tool_data.py` = format și validare trajectorii) |
| Constructor date HF (nou) | branch `agent/hf-data-mix`, `forge/hfmix/build_mix.py` + `test_build_mix.py` (7 teste trec) |
| Benchmark Swypik/SwypikOS (100 sarcini, înghețat) | branch `agent/swypik-bench-v1`: `bench/swypik-v1/tasks.jsonl`, generator `forge/bench/build_swypik_bench_v1.py` |
| Spec GPU voluntar (P2P, etapa 7 SwypikOS) | `docs/plans/2026-09-28-volunteer-gpu-tasks.md` (branch `agent/swypik-bench-v1`) |
| Pilot v7 (notebook complet) | `forge/colab/Ilaria_Project_V7_Pilot.ipynb`, helpers `forge/colab/pilot_preflight.py` (necomise, branch `agent/colab-training-preflight-20260928`) |
| Drive (cont vargaabel12@gmail.com) | `MyDrive/ilaria/swypikos-en/` → `datasets/`, `runs/`, `reviews/`, `colab-v7/` |
| Launcher v7 / v8 pe Drive | `colab-v7/Ilaria_V7_Pilot_Launcher.ipynb`, `colab-v7/Ilaria_V8_HFMix_Launcher.ipynb` |
| Codul folosit în Colab | descărcat din commit-ul public `5c1afaaa295eb08d9cea1560dfdcf055a542a2be` + fișiere din `colab-v7/`, toate verificate SHA-256 |

## Ce s-a făcut azi (verificat)
- **Pilot v7** (50 pași LoRA din v5, lr 2e-5, r16/α32) a rulat complet pe Colab G4. Adaptor: `runs/project-v7-pilot-20260928-50steps/adapter-step50`.
  Evaluare manuală pe 12 probe: v5 ≈ 4/12 → v7 ≈ 6/12. **Nepromovat.** Slab: cod Swyp (scrie Python), subiecte de e-mail, anunțuri.
- Fișierele `datasets/project-v6/{train,validation}.jsonl` aveau CRLF; au fost normalizate la LF (hash = manifest), backup `*.crlf-backup`.
- **hfmix-v1** (neconstruit încă pe Drive): glaive-function-calling-v2 (20k), hermes-function-calling-v1/func_calling (5k),
  oasst2 (12k, arbori best-ranked), aya (10k, multilingv), gsm8k (7.5k), MetaMathQA (8k), Magicoder-OSS-Instruct (8k) + project-v6.
  Prompt de sistem = promptul de serving cu lista de instrumente a fiecărui exemplu (identic byte-cu-byte cu cel din pilot când
  lista e calc/time/convert). PII mascat la oasst2/aya; excluse promptele din bench și din probele v7.

## Sarcinile tale, în ordine
1. **Rulează v8 în Colab**: deschide `colab-v7/Ilaria_V8_HFMix_Launcher.ipynb`, runtime H100 (sau A100/G4 dacă nu e liber),
   rulează toate celulele. Utilizatorul trebuie să apese „Conectați-vă la Google Drive”. Celula 3 construiește datele (prima dată),
   celula 5 antrenează 1500 pași din v7 (`--lr 1e-4 --accum 8 --max-length 2048`), celula 6 scrie
   `reviews/hfmix-v8-1500steps/after-v8-step*-python.json`. Urmărește progresul prin fișierele de pe Drive.
   Verifică `manifest.json` al setului (rânduri pe sursă, limbi, statistici `invalid/duplicate/benchmark_leak`) și raportează-le.
   Dacă ceva pică, citește eroarea exactă; verificările sunt fail-closed intenționat — nu le ocoli, repară cauza.
2. **Compară v5 / v7 / v8** pe cele 12 probe și apoi pe **bench/swypik-v1** (100 sarcini). Scrie un evaluator Python pentru Colab
   care rulează bucla de instrumente (execută calc/convert/time real) și notează automat `expected_tool`, `expect_substring`,
   `must_not_contain`; rubricile le notezi separat, orb față de model. Raportează pe categorii.
3. **Colab MCP** (`github.com/googlecolab/colab-mcp`) e instalat: `C:/Users/Pos5/.local/bin/colab-mcp.exe`, config în `D:\nexus\.mcp.json`
   (fișier necomis). Pornit manual răspunde în ~8 s; în sesiunea precedentă toate serverele MCP stdio au depășit limita de 30 s la pornire.
   Dacă uneltele colab-mcp există la tine, folosește-le în locul Chrome pentru a rula celulele. Dacă nu, cere utilizatorului Reconnect din UI.
4. **Mai multe Colab-uri în paralel (DiLoCo prin Drive)**: utilizatorul vrea să lege mai multe sesiuni Colab pe plăci diferite.
   Proiectează și implementează un coordonator: fiecare worker antrenează LoRA pe shard-ul lui N pași, urcă adaptorul pe Drive,
   un pas de merge face media (outer step), toți continuă din versiunea comună. Include: shard-uri deterministe, rundă versionată,
   hash-uri, retry, verificare NaN/normă, loss pe validare nu are voie să regreseze. Testează local cu `--smoke` înainte de Colab.
   Fii onest: câștig ~2–2,5× pe 3 sesiuni, fiecare sesiune consumă unități Colab separat.
5. **Rulajul mare (€100 ≈ 2,5–3 h pe 8× H200 pe brev.nvidia.com)**: DOAR după ce rețeta arată creștere clară pe bench.
   Brev are $0 credit și niciun card — utilizatorul îl pune. Pregătește scriptul multi-GPU (trainer-ul are suport torchrun DDP,
   probează-l pe Colab întâi) și estimarea exactă de timp/cost înainte de a cere pornirea.
6. **Date noi țintite** pe slăbiciunile măsurate: cod Swyp verificat cu compilatorul (`D:\swyp lang`, și `swyp/` în repo),
   texte scurte (subiecte, anunțuri) fără fapte inventate, refuz/aprobare pentru acțiuni OS periculoase.

## Probleme deschise de semnalat utilizatorului (nu le rezolva fără acord)
- Pe GitHub-ul public (commit `5c1afaa`, pus de ChatGPT) sunt `DE_CITIT_URGENT_CLAUDE_OPUS.md` (conține data nașterii
  fondatorului și afirmații neverificate), `analysis.txt`, `core_structs.txt`, 38 fișiere din `data/`. Propunere: commit de ștergere;
  rescrierea istoricului (force push) e decizia lui.
- Modificări necomise ale ChatGPT în `D:\nexus` (headless ilaria-serve, ștergerea dashboard-ului web, sandbox RunGo fail-closed):
  gate-urile trec (verificat), așteaptă decizia de commit.
- Aplicația AWS Activate e completată, nesubmisă: lipsesc data reală a înființării firmei (formularul avea 15.01.2025 — probabil greșit;
  CUI înregistrat TVA 22.08.2025) și data de lansare (formularul avea 01.10.2026).
- Azure: $5.000 credit (expiră 20.06.2027) dar **fără GPU** pe acest abonament (confirmat de suport, tichet 2609250050002143).
- A apărut în istoricul Colab „Based-ROOP.ipynb” (deepfake, cont străin based9based@gmail.com) deschis la 10:05 — nu de agent;
  utilizatorul trebuie să verifice securitatea contului Google.

## Cum raportezi
Scurt, în română: ce ai rulat, ce a ieșit (cifre reale, cu fișierul sursă), ce a eșuat și de ce, următorul pas propus.
Nu spune „mai bun” fără scor pe bench; nu spune „gata” fără gate-uri rulate.
