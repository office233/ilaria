# Predare Claude — audit complet + remedieri (2026-10-02)

Raport: `E:\nexus-training\evidence\claude-audit-20261002\AUDIT-proiect-2026-10-02.md`. Acceptare: `…\claude-audit-20261002\acceptance-fixes.json`. Chitanțe și backup-uri: `…\fix-n1`, `…\fix-c1`, `…\fix-c2`. Fără commit/push.

## Rulare teste Python (nou)
`python scripts/run-python-tests.py` — o sesiune pytest izolată per suită, cu cwd/env ale owner-ilor (`--list`, `--only`, `--python`). Main: 18/18 suite pe Windows py3.12 și WSL py3.14.

## Owner imc-consent-revocation / supervision-p2p-admission
Verifierul `scripts/verify-imc-consent-revocation.py` era blocat din 11:09 (pin `HELPER_SHA` vechi după I-2/I-4, apoi fixture fără splitul `sealed` adăugat la I-3). Reparat (+ testul aliniat); unit 39/39; dovadă reală nouă PASS: `…\fix-n1\consent-proof\tmp-144119\bounded-revocation-xipjjsnd\receipt.json`. Hash-urile `44e14337…`/`7e73fe94…` din planurile voastre descriu versiunea veche; actual: verifier `dd10c14e238b`, test `291922d726c4`.

## Owner `ilaria/forge/freeze_eval_benchmarks.py`
`test_freeze_eval_benchmarks.py` importă `pandas` la nivel de modul, dar jobul CI „Validate Ilaria Forge” instalează doar torch/numpy/tokenizers/pytest: după commit, CI va eșua. Adăugați `pandas` fixat în CI sau `pytest.importorskip("pandas")`.
**Închis 2026-10-02T13:25Z (Copilot):** CI instalează `pandas==3.0.6 pyarrow==25.0.1` (pyarrow e necesar pentru `read_parquet`/`to_parquet`).

## Owner-ii loturilor înghețate `brev_billing_terms` și `imc_nccl_hardware_gate`
Ambele importă `gate`/`test_gate` ca module top-level, deci nu pot împărți o sesiune pytest (rezolvat prin runner, fără să le ating fișierele). La următoarea revizie: nume unice sau pachet (`__init__.py` + `from . import gate`).

## Agentul care editează `swyp/scripts/build-local.ps1`
Scrie `build.json` cu `-Encoding UTF8`, adică BOM în Windows PowerShell 5.1; parserele JSON stricte îl resping. Aplicați soluția din `swypik-os/scripts/build.ps1` (`[IO.File]::WriteAllText(..., (New-Object System.Text.UTF8Encoding $false))`).
**Închis 2026-10-02T13:25Z (Copilot):** aplicat și verificat prin rulare reală (`build.json` fără BOM, `json.load` strict OK).

## Agentul care editează `scripts/verify-native-cleanup.py`
ruff F401: import nefolosit la linia 8.
**Închis 2026-10-02T13:25Z (Copilot):** `import sys` eliminat; `py_compile` OK.

## 37 de fișiere Python cu warning-uri ruff lăsate intenționat
Au hash-uri fixate în dovezi, manifeste sau pin-uri de sursă (ex. `imc_model.py` = `MODEL_SHA` în verifierul de consimțământ). Curățați-le doar odată cu actualizarea pin-urilor, în stadiul owner-ului.

## Swypik commerce (`E:\Swypik\swypik-commerce-platform`, branch `fix/p0-security-ci-integrated`)
Modificări necommitate: C1 (10 fișiere) + C2 (42 de fișiere, plus helperul nou `lib/error-message.ts`); liste exacte în `fix-c1\receipt.json` și `fix-c2\receipt.json`. Worktree: `E:\Swypik\_wt\claude-audit-fixes-20261002` (`codex/claude-audit-fixes-20261002`; `node_modules` e junction spre checkout-ul principal). Gate-uri: tsc 0, vitest 2583/2583 (+3 skip), lint 0 erori și 189→113 warning-uri, i18n OK, `next build` OK.
Rămase: 35 de warning-uri ESLint în fișiere la care lucrează alți agenți; 78 de `any` (rânduri DB netipate, payload-uri Duffel/Kiwi/RateHawk, genericele `<T = any>` din `lib/db.ts`, a căror schimbare cascadează în sute de apeluri), deci e nevoie de un stadiu separat de tipare. `app/api/cron/disk-watch/route.ts` menționează încă scriptul WSL retras în textul alertei (decizie de produs pentru Azure).

## Continuare — tipare commerce (2026-10-02T12:51:14Z)
- 78 de `any` eliminate din 24 de fișiere curate (rânduri DB, Duffel Flights/Stays, Kiwi, RateHawk, orchestrator, search-pg, feed-normalize, pagini). Chitanță: `E:\nexus-training\evidence\claude-typing-20261002\receipt.json`.
- Tiparea a scos la iveală 2 bug-uri, reparate: `orchestrator` putea întoarce `productId` numeric / `productTitle` null; `feed-normalize` putea pune un obiect în câmpul URL `video`.
- `lib/db.ts`: genericele implicite `<T = any>` rămân, cu excepție documentată (schimbarea lor cascadează în 14+ fișiere, inclusiv în lucrul altor agenți).
- Verificat cu overlay: toate cele 252 de fișiere modificate/neversionate ale altor agenți compilează cu tipările noi (tsc 0). Main: lint 113→35 warning-uri, toate în fișierele altor agenți; tsc 0; vitest 2583/2583; build OK.
