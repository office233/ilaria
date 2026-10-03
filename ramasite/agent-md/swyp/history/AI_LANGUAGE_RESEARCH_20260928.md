# Swyp: cercetare de arhitectură și campanie experimentală

Data: 28 septembrie 2026, Europe/Bucharest. Workspace: `D:\swyp lang`.
Commit de bază: `650d88616da46cbc0f459f7af29991654d00e507`.
Branch observat: `work/local-swyp-validation-20260928`.

## 1. Decizia de arhitectură

Direcția propusă este un limbaj în care intenția, contractele, codul, efectele permise și dovezile de verificare sunt artefacte explicite. Generatorul propune; compilatorul și evaluatorii verifică; executabilul nu depinde implicit de un model. Obiectivul nu este reducerea tuturor problemelor la un prompt și nici înlocuirea semanticii prin predicții.

Separăm trei obiective: AI care ajută la scrierea programelor; execuție eficientă pentru programe de AI; AI care propune optimizări ale compilatorului. Sunt probleme și evaluări diferite. Campania de aici a implementat o optimizare STV2, a construit instrumente reproductibile de evaluare și a măsurat sinteza deterministă existentă. Nu a implementat un model, un sistem de tensori, un backend GPU sau un sistem complet de contracte.

Criteriul de selecție propus este o frontieră Pareto: corectitudine obligatorie, apoi latență, memorie, dimensiune, cost de compilare și efort de dezvoltare. O variantă incorectă nu poate compensa printr-un scor bun de viteză. Nu stabilim un clasament universal al limbajelor din trei microbenchmarkuri.

## 2. Cercetare: mecanisme utile și decizii pentru Swyp

Sursele primare sunt enumerate la final. Afirmațiile despre implementările externe sunt distincte de propunerile noastre.

### Contracte și sinteză ghidată de contraexemple

Dafny exprimă precondiții, postcondiții și invariante, iar SyGuS/cvc5 combină o gramatică de programe cu restricții logice [S1, S2]. Propunere: un contract Swyp să definească domeniul intrărilor, relația intrare-ieșire, erorile admise și bugetele, nu doar câteva exemple. Rezultatul verificării trebuie să distingă `tested`, `proved_under_assumptions`, `unknown`, `counterexample` și `timeout`. Un timeout nu este dovadă că programul este corect sau imposibil.

Pentru început, un solver eventual integrat ar trebui limitat la un subset bine definit. Demonstrarea unei proprietăți pe întregi matematici nu demonstrează automat aceeași proprietate pentru float64, pentru întregi cu overflow sau pentru mașina STV2. Experimentele din secțiunea 5 arată deja utilitatea contraexemplelor, fără a folosi un LLM.

### Reprezentare intermediară tipizată, înainte de extinderea backendurilor

MLIR oferă un model de reprezentări intermediare pe niveluri și transformări progresive către țintă [S3]. Pentru Swyp propunem inițial un IR mic, propriu, implementat în Go: blocuri, valori tipizate, control-flow explicit, poziții sursă, operații care pot produce erori și apeluri cu efecte declarate. Un verificator trebuie rulat după fiecare transformare.

Adoptarea directă a întregului ecosistem MLIR nu este o condiție pentru acest pas. Evaluarea unui adaptor MLIR/LLVM devine justificată când există tipuri agregate și operații tensoriale care beneficiază de acesta. Interpretul AST rămâne unul dintre oracole; noile teste includ și oracole independente de parser și AST.

### Tipuri numerice și memorie explicită

Rust verifică reguli de ownership la compilare, iar Mojo documentează convenții de proprietate și acces mutabil/imutabil [S4, S5]. Pentru Swyp acestea sunt repere de proiectare, nu componente deja implementate. Propunerea este separarea tipurilor întregi și flotante, conversii explicite și un comportament de overflow specificat. Apoi: arrays/slices, structs, reguli de aliasing și ownership, înainte de concurență sau acces GPU.

Optimizarea din această campanie diferențiază doar registre temporare de registre citite fără modificare. NU este un borrow checker pentru programele Swyp. De asemenea, măsurarea Go din secțiunea 4 susține investigarea reprezentărilor numerice; nu justifică schimbarea tacită a tipului `number` existent.

### Efecte și capabilități pentru cod generat

Koka urmărește efectele în tipuri; WASI folosește interfețe și un model de capabilități pentru accesul la resurse [S6, S7]. Propunere: funcțiile pure să fie distincte de operațiile filesystem, network, clock și model. Codul generat să primească doar capabilitățile declarate. Această separare ar ajuta atât verificarea, cât și optimizarea.

Un effect checker nu este singur un sandbox. Limitele de proces, memorie, fișiere și rețea trebuie impuse și de runtime/host. STV2 nu primește instrucțiuni de host-call în această modificare. O țintă WASM/WASI ar fi un proiect separat, nu o redenumire a SWYPB.

### Optimizare cu reguli verificate, nu rescrieri optimiste

Equality saturation, exemplificată de egg, explorează variante construite din reguli de rescriere; Alive2 validează transformări LLVM, cu limite documentate [S8, S9]. Propunere: un experiment Swyp să compare mai întâi transformări locale, cu bugete și verificare diferențială, înainte de un optimizer general cu e-graphs.

De exemplu, în profilul STV2 exact, `(x + 1) - 1` NU poate fi înlocuit întotdeauna cu `x`: pentru intrarea maximă permisă, expresia originală depășește domeniul la pasul intermediar. Testele noi verifică păstrarea acestei erori. Regulile pentru întregi, float64 strict și eventuale moduri relaxate trebuie separate; nu eliminăm verificările numerice ca să obținem un benchmark favorabil.

### Generare de variante și calcul AI

AlphaEvolve este un precedent pentru combinarea generării de propuneri, evaluatorilor automați și căutării evolutive [S10]. Îl folosim ca reper de arhitectură, nu ca promisiune că Swyp reproduce rezultatele Google. Propunerea noastră este ca fiecare candidat să conțină diff, hashuri, comenzi de verificare și rezultate reproductibile; evaluatorul de corectitudine nu trebuie controlat de candidat.

Triton este un limbaj și compilator pentru kerneluri GPU [S11]. Comparația cu el ar necesita aceeași placă, aceleași precizii, date, transferuri și criterii de calitate. Regresia liniară scalară din această campanie nu măsoară performanța unui framework de deep learning și nu autorizează afirmații despre antrenarea unui LLM.

## 3. Implementat: reducerea copiilor și presiunii pe registre în STV2

Fișiere de producție: `internal/swyplang/stv2.go` și noul `internal/swyplang/stv2_operands.go`.

Baseline-ul copia fiecare variabilă/argument într-un registru temporar, inclusiv atunci când consumatorul doar citea valoarea. Am introdus un operand care distinge un registru temporar de unul împrumutat pentru citire. `let` păstrează o valoare proprie; expresiile compuse și operandul stâng mutabil păstrează temporare. Evaluarea nu este reordonată.

Au fost implementate și măsurate trei stări:

| Variantă | Modificare | Instrucțiuni sumă | Modul |
|---|---|---:|---:|
| Baseline | Copii originale | 18 | 157 B |
| R1 | Citire directă pentru operandul drept | 17 | 152 B |
| R2, păstrată | R1 plus consumatori read-only la nivel de instrucțiune sursă | 16 | 146 B |

R2 acoperă atribuiri, expresii ignorate, return și condiții if/while. Eliberăm numai temporarele, nu registrele variabilelor sau ale argumentelor. Ipoteza critică este că singurul apel permis de preflight este `arg`, iar registrele de intrare sunt rezervate. Extinderea cu apeluri ce au efecte impune reanalizarea acestei optimizări.

### Rezultatul controlat în același proces

`stv2-interleaved.json`: același VM final și aceeași intrare 1000; rezultat verificat 500500 la fiecare execuție; 200 warmups/modul, 9 runde, 8.000 execuții/eșantion; ordine serială amestecată cu seed 20260928. Total: 216.000 execuții măsurate, plus warmups.

| Variantă | Mediană ns/execuție | Minim | Maxim | Pași pentru intrarea 1000 |
|---|---:|---:|---:|---:|
| Baseline | 32.415,30 | 31.907,86 | 33.039,95 | 13.008 |
| R1 | 30.731,54 | 29.875,13 | 31.636,20 | 12.008 |
| R2 | 30.427,49 | 30.060,76 | 56.066,56 | 12.007 |

R2 are o mediană observată cu 6,13% mai mică decât baseline-ul în acest experiment, modul cu 7,01% mai mic și cu 11,11% mai puține instrucțiuni. Eșantionul lent R2 este păstrat, nu eliminat. Nu am calculat intervale de încredere și nu afirmăm semnificație statistică pentru diferența mică R1-R2. R2 aduce în plus cazuri valide care anterior nu încăpeau în registre.

Măsurătorile inițiale separate `go test -bench` sunt păstrate în fișierele `stv2-*-bench.txt`. Nu folosim diferența lor mai mare ca rezultat principal, deoarece driftul sistemului poate afecta rularile separate.

### Corectitudine și compatibilitate

`stv2_operands_test.go` adaugă patru funcții de test, incluzând șapte cazuri de presiune inutilă pe registre care au eșuat înaintea patchului și au trecut după. Sunt verificate aliasing, shadowing, mutații, scurtcircuitare, erori numerice și valori ignorate. Opt registre efectiv ocupate plus un temporar nou continuă să fie respinse: spilling nu a fost implementat.

Generatorul final produce 1.200 de surse DISTINCTE, confirmate cu un set de unicitate, și 10.800 de perechi program/intrare. Fiecare este verificată față de interpretul AST și față de un oracle independent scris în Go. Modulele sunt serializate/reîncărcate și recompilarea trebuie să fie deterministă. Generatorul inițial avea repetiții; dovada finală este `stateful-independent-oracle.txt`, nu numărul inițial de extrageri aleatorii.

Formatul SWYPB, opcode-urile și limitele numerice nu s-au schimbat. Modulele vechi de 157 B au fost executate în VM-ul actual. Fuel-ul este măsurat în instrucțiuni VM; codul optimizat poate consuma mai puțin fuel pentru aceeași intrare. Nu promitem aceeași limită de eșec la același fuel între două compilări diferite.

Testul final cu sursa copiată apoi ștearsă și PATH fără toolchain a produs pentru intrarea 100: `value=5050`, `steps=1207`, `instructions=16`, `module_bytes=146`. Copia temporară a fost eliminată; executabilul existent al proiectului nu a fost înlocuit.

## 4. Comparație reală cu alte limbaje

Host: Intel Core i7-9700, Windows amd64. Go 1.26.2, GCC/G++ 15.2.0, Python 3.12.10, Node v24.15.0. Rust nu a fost măsurat: `rustc` lipsește din PATH. Nu am instalat toolchainuri.

Am creat `research_campaign.py` și `reference.js`, fără a suprascrie runnerul sau rapoartele istorice. Toate buildurile sunt în directoare noi. Algoritmii sunt aceiași, scalari și secvențiali, cu reprezentare float64. C și C++ folosesc aceeași sursă în stil C, `-O2 -ffp-contract=off`, fără fast-math. Fiecare implementare are un proces de warmup separat și cinci procese măsurate; ordinea este amestecată determinist, iar execuțiile sunt seriale.

Total: 105 eșantioane măsurate, 21 warmups și trei rulari oracle Python, separat de builduri. Rezultatele și parametrii de antrenare sunt verificate înainte de acceptarea măsurătorilor. Numărul de prime este verificat și printr-un ciur independent.

### Mediane ale regiunii cronometrate, milisecunde

| Implementare | Mandelbrot 320 × 160 | Prime până la 50.000 | Regresie 256 × 1.000 epoci |
|---|---:|---:|---:|
| C | 3,1730 | 7,0462 | 1,7548 |
| C++ | 3,5686 | 5,9460 | 1,7944 |
| Go float64 | 4,9524 | 64,4883 | 4,1899 |
| JavaScript / Node | 5,2821 | 3,9850 | 6,5430 |
| Swyp nativ | 14,5790 | 11,2722 | 6,1963 |
| Python | 213,4617 | 129,2733 | 100,0790 |
| Swyp interpret AST | 1.254,3899 | 500,2565 | 294,3910 |

Node execută referința JavaScript scrisă pentru aceiași algoritmi, NU codul JS emis de Swyp. STV2 nu este inclus în această matrice float64: subsetul său nu acceptă aceste programe complete. Aceasta este o comparație între implementările precizate, nu între întregi ecosisteme.

Pe aceste sarcini, Swyp nativ este aproximativ 11,5-16,2 ori mai rapid decât Python și 1,6-4,6 ori mai lent decât C. Interpretul AST Swyp este mai lent decât Python în toate cele trei. Optimizarea STV2 nu modifică backendul C și nu explică performanța sa nativă.

### Control pentru reprezentarea numerică

Test separat: același executabil Go, același algoritm trial division, limita 50.000, rezultatul 5.133, nouă eșantioane/profil, ordine amestecată și un warmup/profil.

| Profil | Mediană ms | Minim | Maxim |
|---|---:|---:|---:|
| Go float64 cu math.Mod | 63,6658 | 62,3211 | 64,5818 |
| Go cu rest întreg | 8,1272 | 7,8670 | 8,4020 |

Diferența observată este de aproximativ 7,83 ori. Nu folosim rândul Go float64 drept dovadă că Swyp este în general mai rapid decât Go. Schimbarea reprezentării numerice este intenționat un alt experiment, nu o semantică identică în matricea principală. Dovadă: `go-numeric-profile.json`.

### Limitele măsurării

Timpii din tabel exclud pornirea procesului; rapoartele păstrează și wall time. De exemplu, Node are aproximativ 60,03 ms wall time la Mandelbrot, față de 5,28 ms intern. Procesele Node sunt noi, fără warmup persistent de JIT. Regiunea de antrenare include o singură afișare WEIGHTS în fiecare implementare. Swyp păstrează verificări finite-arithmetic și fuel pe care referințele nu le reproduc.

Desktopul nu a fost izolat; există outliers. Buildurile folosesc cache-urile existente, deci nu sunt măsurători cold-build. Dimensiunile executabilelor și timpii de build sunt în JSON; nu am măsurat peak RSS, energie, SIMD, biblioteci optimizate, GPU, aplicații web complete sau concurență. Nu există un rezultat local de performanță pentru Rust, Mojo, Koka, Dafny ori Triton.

## 5. Sinteză: 24 de configurații și un contraexemplu important

`benchmarks/swyp/synthesis_matrix.py` evaluează opt sarcini la bugete de 32, 512 și 20.000 de candidați, maximum șapte noduri, constante [-1,0,1,2]. Este sinteză deterministă fără LLM. Opt intrări ținute separat de căutare sunt testate pentru fiecare candidat în interpret și în executabilul nativ: [-7.5,-2.5,-0.5,0.25,0.5,1.5,3.5,6.5].

| Sarcină | 32 | 512 | 20.000 |
|---|---|---|---|
| Identitate | PASS | PASS | PASS |
| 2x+1 | Fără candidat | PASS | PASS |
| x² | Fără candidat | PASS | PASS |
| x³ | Fără candidat | PASS | PASS |
| x²+x+1 | Fără candidat | Fără candidat | PASS |
| Valoare absolută | Fără candidat | Fără candidat | Fără candidat |
| x², doar exemplele 0 și 1 | Eșec pe intrări noi | Eșec pe intrări noi | Eșec pe intrări noi |
| x², aceleași exemple plus validare -1 și 2 | Fără candidat | PASS | PASS |

Rezultat: 12 configurații trec intrările noi; trei generează un candidat care se potrivește exemplelor, dar nu funcției dorite; nouă nu găsesc candidat în căutarea respectivă. Cele 15 surse generate au fost testate de 240 de ori în total pe intrări noi și două backenduri. PASS se referă exclusiv la aceste verificări finite, nu la o demonstrație universală.

Exemplul decisiv: din 0→0 și 1→1, motorul propune `return x;`, după un singur candidat. Creșterea bugetului nu rezolvă ambiguitatea. Adăugarea punctelor de validare -1 și 2 conduce la `return (x*x);`, cu 57 candidați, două runde și un contraexemplu adăugat. Cele opt intrări noi rămân ascunse căutării și trec după rafinare.

Pentru valoarea absolută, la bugetul mare motorul a raportat epuizarea spațiului până la max_nodes=7. Aceasta nu este o demonstrație că funcția nu poate fi sintetizată. Propunere de experiment ulterior: comparații și expresii condiționale în gramatică, cu bugete și evaluare pe sarcini separate. Nu extindem automat gramatica în acest patch.

Dovadă completă: `synthesis-matrix/report.json`, inclusiv specificațiile, sursele, hashurile, fiecare comandă, exit code și fiecare intrare verificată.

## 6. Validare finală executată

| Verificare | Observație |
|---|---|
| go test ./... -count=1 -timeout=90s | PASS: șapte pachete cu teste; șapte fără teste |
| go vet ./... și go build ./... | PASS |
| go vet pentru research_driver.go | PASS |
| Race: swyplang, cmd/swyp, ternaryvm | PASS |
| Fuzz compilator STV2, 10 secunde, doi workers | PASS, 81.561 execuții |
| Fuzz loader SWYPB, 10 secunde, doi workers | PASS, 533.953 execuții |
| Generator distinct + oracle independent | PASS, 1.200 surse, 10.800 cazuri |
| Parserul de rezultate benchmark | Patru funcții unittest PASS, cu subcazuri malformate |
| Python py_compile și Node --check | PASS |
| gofmt -l și git diff --check | Fără probleme raportate |
| Execuție reală fără sursă și toolchain pe PATH | PASS, 5050, modul 146 B |

Cele 615.514 execuții de fuzzing nu înseamnă tot atâtea programe distincte sau valide. Go folosește fuzzing ghidat de acoperire [S12]; aceste rulari scurte nu demonstrează absența defectelor. Testele existente de generare diferențială STV2 și contract SWYPB sunt păstrate, nu înlocuite.

Nu am pornit CI remote. Assertion-ul de dimensiune din workflow a fost actualizat la 146 B, iar echivalentul smoke testului a fost executat local. Bridge-ul LSP nu este disponibil pe portul 3005; nu pretindem un rezultat curat de la editor. Verificările de mai sus sunt rezultatele efective.

## 7. Agenții Antigravity: blocaj identificat exact

Două apeluri spawn_antigravity_agent au fost făcute în această campanie, pentru audit semantic și metodologie benchmark. Ambele au returnat doar confirmarea textuală a providerului `chatgpt-web`, fără comenzi sau constatări. Nu sunt două audituri independente finalizate.

Inspecția `D:\chat-gpt-bridge\server.js`, liniile 1704-1721, a identificat implementarea endpointului `/v1/chat/completions`: acesta construiește un șir fix din mesajul utilizatorului, în loc să execute o inferență. La linia 1719 este chiar textul primit de la agenți. Acesta explică răspunsurile observate; a marca launcherul drept completed nu dovedește că agentul a lucrat.

Nu am modificat bridge-ul, configurația providerului sau credențialele. Toată execuția verificabilă de aici a fost făcută direct prin uneltele Antigravity. Workers de fuzzing sunt procese de test, nu agenți AI independenți.

Pentru delegare reală, criteriul propus este: un test smoke cu acces read-only trebuie să returneze un rezultat derivat dintr-un fișier și stdout/exit code reale; endpointurile neconfigurate trebuie să raporteze eroare, nu succes simulat. Ulterior: workspaces izolate pentru candidați, evaluatori separați, bugete CPU/memorie și integrare exclusiv după verificare. Pe acest host, nu propunem zeci de procese grele simultan.

## 8. Milestones propuse, încă neimplementate

### M0 — delegare și dovezi

Înlocuirea rutei demonstrative a providerului cu o integrare autentică, explicit configurată, fără expunerea secretelor; statusuri distincte pentru launch, tool execution și verified completion. Manifest pentru fiecare candidat: hash sursă, compiler build, versiune gramatică, seed, bugete, teste și statusul dovezii. Acceptare: smoke testul independent și repetabil descris mai sus.

### M1 — Semantic Core și Contract IR

Introducerea IR-ului tipizat și a contractelor separate de limbaj natural. Model conceptual: intenție → contract → candidat → verificare → sursă fixată → compilare deterministă. Niciun LLM la execuția normală. Tipuri întregi și flotante distincte, efecte explicite și diagnostice structurate pentru oameni și agenți. Acceptare propusă: corpus cu cel puțin 10.000 de programe distincte, cazuri numerice de frontieră și concordanță între backenduri numai pe domeniile lor comune.

### M2 — optimizare și registru/memorie

Liveness pe control-flow și alocare reală de registre, apoi evaluarea spilling-ului cu ABI și format versionat dacă devine necesar. Arrays/slices, structs și reguli de aliasing înainte de optimizări de memorie agresive. Acceptare: teste de presiune, bucle, ramuri, shadowing și păstrarea erorilor, plus măsurarea costului de compilare și memorie. Nu schimbăm simultan toate backendurile.

### M3 — sinteză mai expresivă, verificator independent

Comparații și condiționale, contracte de domeniu și verificare simbolică pe un subset. Evaluare separată pentru găsirea candidatului, generalizare, timeout și cost. Seturile held-out nu trebuie folosite pentru selecția candidatului. Acceptare: comparație cu baseline-ul pe aceleași specificații și aceleași bugete, păstrând și rezultatele negative.

### M4 — execuție AI și aplicații reale

Operații tensoriale cu shape/dtype/layout explicite; adaptor către un backend consacrat înainte de kerneluri proprii generalizate. Separat, modules/packages, interfețe C/Python și o țintă sandboxed. Acceptare: workloaduri aplicație și tensoriale cu date/precizie identice, timp end-to-end, memorie, cost de transfer și verificarea calității rezultatului. Numărul de linii sau tokeni generați nu este singur un indicator de productivitate.

Pentru comparațiile viitoare păstrăm două profiluri: algoritmi și reprezentări identice pentru a izola compilarea; apoi implementări idiomatice pentru aceeași sarcină finală. Al doilea profil trebuie etichetat separat, cum am făcut deja cu Go integer primes.

## 9. Fișiere, reproducere și proveniență

Dovezile sunt în `docs/research/20260928-ai-language/`. Rapoartele JSON păstrează eșantioanele brute, versiunile și rezultatele; logurile PowerShell pot fi UTF-16 cu BOM, rapoartele Python sunt UTF-8. Snapshoturile baseline/R1/R2 sunt arhive text, nu fișiere Go active.

Comenzi reproductibile, din rădăcina proiectului. Directoarele de output trebuie să fie NOI; executabilele de mai jos sunt buildurile separate produse în această campanie:

```powershell
go test ./... -count=1 -timeout=90s
go test ./internal/swyplang -run '^TestSTV2(ReadOnlyOperandPressure|Operand)' -count=1 -v
python benchmarks/swyp/research_campaign.py --self-test
python benchmarks/swyp/research_campaign.py --case mandelbrot --size 320 --repetitions 5 --output bin/research-next-mandelbrot
python benchmarks/swyp/synthesis_matrix.py --tool bin/swyp-research-20260928-r2.exe --output bin/research-next-synthesis
.\bin\swyp-research-20260928-driver.exe compare-modules docs/research/20260928-ai-language/sum-baseline.swypb docs/research/20260928-ai-language/sum-r1.swypb docs/research/20260928-ai-language/sum-r2.swypb
```

Fișiere noi de lucru: `stv2_operands.go`, `stv2_operands_test.go`, `reference.js`, `research_campaign.py`, `research_driver.go`, `synthesis_matrix.py` și acest raport. Modificări existente ale campaniei: `stv2.go`, documentația SWYPB și assertion-ul workflow-ului. Fixurile anterioare de parser și CLI și lucrările utilizatorului din bridge/scripts/launcher au fost păstrate.

Nu s-a făcut commit, push, reset, clean, instalare de toolchain sau pornire de servicii persistente. `bin/swyp.exe` nu a fost înlocuit. Fișierele noi rămân untracked până la includerea lor explicită în Git; un commit doar al fișierelor deja tracked ar omite teste și noul helper de compilare.

## 10. Surse primare consultate

Surse consultate pentru design, nu pentru a înlocui măsurătorile locale. Data consultării: 28 septembrie 2026. Nu este o revendicare de prioritate științifică sau o revizie exhaustivă a tuturor limbajelor.

- [S1] Dafny, ghidul oficial: https://dafny.org/latest/OnlineTutorial/guide
- [S2] cvc5, exemplu oficial SyGuS: https://cvc5.github.io/docs/latest/examples/sygus-fun.html
- [S3] MLIR, rationale: https://mlir.llvm.org/docs/Rationale/Rationale/
- [S4] Rust Book, ownership: https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html
- [S5] Mojo, ownership: https://mojolang.org/docs/manual/values/ownership/
- [S6] Koka, cartea oficială: https://koka-lang.github.io/koka/doc/book.html
- [S7] WASI, documentație oficială: https://wasi.dev/
- [S8] egg, equality saturation: https://egraphs-good.github.io/egg/egg/tutorials/_01_background/index.html
- [S9] Alive2, repository și limite documentate: https://github.com/AliveToolkit/alive2
- [S10] Google DeepMind, AlphaEvolve, 14 mai 2025: https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/
- [S11] Triton, documentație oficială: https://triton-lang.org/main/index.html
- [S12] Go, fuzzing: https://go.dev/doc/security/fuzz/
