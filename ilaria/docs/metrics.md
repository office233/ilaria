# Ilaria Capability Scoreboard Metrics

Acest document descrie modelul de măsurare și calibrare a inteligenței emergente pentru sistemul non-LLM **Ilaria**.

---

## 1. Structura Metricilor

Evaluarea folosește trei seturi de date fixe (JSONL) pentru a calcula performanța:
1. **Seen Training Recall (`basic_recall.jsonl`)**: Testează doar recuperarea faptelor văzute în antrenare. Nu este benchmark de inteligență generală și nu trebuie raportat ca generalizare.
2. **Anti-Echo Boundaries (`no_echo.jsonl`)**: Măsoară stabilitatea cognitivă a organismului. Întrebările ciudate sau cuvintele necunoscute nu trebuie să producă un efect de „papagal digital” (prompt echoing).
3. **Held-out Generalization (`generalization.jsonl`)**: Măsoară parafraze, întrebări necunoscute și raționament simplu care nu trebuie rezolvate prin potrivire exactă QA.

### Metricile de Bază

*   **Recall Rate**: Procentul cazurilor de testare în care răspunsul organismului conține toate cuvintele cheie așteptate (case-insensitive).
*   **Echo Rate**: Procentul cazurilor în care răspunsul sistemului este identic cu promptul trimis ca input. 
*   **Anti-Echo Rate**: Calculează stabilitatea ca `100 - Echo Rate`. Un organism matur are un Anti-Echo Rate de `100%`.
*   **Confidence Calibration**: Raportul dintre încrederea medie raportată de Prefrontal Cortex pentru răspunsurile corecte (**Passed Conf**) versus cele greșite (**Failed Conf**). O calibrare perfectă indică faptul că sistemul „știe când nu știe”.

---

## 2. Calculul Scorului Global (Ilaria Capability Score)

Scorul general de capabilitate este determinat prin combinarea liniară ponderată a ratei totale de trecere și stabilității anti-ecou:

$$\text{Ilaria Capability Score} = (\text{Overall Pass Rate} \times 0.80) + (\text{Anti-Echo Rate} \times 0.20)$$

Această formulare penalizează sever sistemele care repetă input-ul, dar raportul trebuie citit împreună cu suita **Held-out Generalization**. Evaluarea default reîncarcă organismul pentru fiecare caz, ca învățarea produsă în timpul evaluării să nu contamineze următoarele cazuri.

---

## 3. Calibrarea Nivelurilor Cognitive

În funcție de scorul obținut de organism, acesta este clasificat pe una dintre următoarele trepte evolutive:

| Scor (0-100) | Clasificare Nivel Cognitiv | Descriere și Capabilități Așteptate |
| :--- | :--- | :--- |
| **>= 90** | **Emergent Agent** | Rezolvare completă a ambelor seturi. Memorie episodică stabilă și generalizare flexibilă a asocierilor. |
| **>= 75** | **Cognitive System** | Recall excelent pe faptele de bază, fără ecouri detectate. Sistemul are o încredere bine calibrată. |
| **>= 50** | **Associative Sandbox** | Organismul reține secvențe simple dar suferă de pierderi de memorie sau confuzii contextuale la asocierile complexe. |
| **>= 20** | **Basic Sequence Engine**| Capabil de asocieri bigram simple. Risc ridicat de a cădea în fallback sau de a genera răspunsuri goale. |
| **< 20** | **Primitive Sand** | Comportament haotic, lipsă totală de memorie sau rată mare de prompt echoing. |

---

## 4. Ghid de Rulare a Evaluării

Pentru a rula benchmark-ul determinist, folosește comanda:

```bash
go run ./cmd/cortex-eval/main.go
```

Opțiuni CLI suportate:
*   `--data-dir` : Calea către starea stocată a organismului (implicit `./data/cortex`).
*   `--seed`     : Seed-ul RNG pentru determinism complet (implicit `42`).
*   `--fresh`    : Rulează evaluarea pe un organism complet gol/nou pentru a vedea performanța de bază.
