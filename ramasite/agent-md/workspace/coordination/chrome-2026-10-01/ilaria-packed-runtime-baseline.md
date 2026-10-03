# Ilaria TritPack20 CPU baseline — 2026-10-01

State: COMPLETE pentru măsurarea operatorului existent; nicio schimbare de produs.
Scope: codec/MatVec pe date sintetice generate în proces; fără modele, corpus, checkpoints, date/chei private, instalări sau API/model calls.

## Metodă și reproducere

- Surse: [README/API](E:/nexus/ilaria/runtime/tritpack20/README.md), [MatVec](E:/nexus/ilaria/runtime/tritpack20/matvec.go), codec.go și format.go. Respectă familia IMC proprie cerută de `ilaria/AGENTS.md`; acest package este o primitivă, nu un transformer complet.
- Host: Windows/amd64, `AMD64 Family 25 Model 1 Stepping 1, AuthenticAMD`, 8 procesoare logice raportate. Modelul comercial CPU nu a fost obținut: CIM a refuzat accesul; nu îl deducem. Compilator existent Go 1.27.1, GOAMD64=v1.
- Benchmark serial: GOMAXPROCS=1, fără worker goroutines; 9 eșantioane per operator/formă, 3 apeluri de încălzire. Repetiții calibrate pentru loturi de cel puțin 25 ms; ordinea packed/dense alternează. Numărul efectiv de repetări, mediană/min/max sunt în results.json.
- Primul probe scurt a avut durate zero pe acest ceas; cifrele sale nu fundamentează tabelul. Loturile calibrate reduc eroarea de rezoluție. O singură rulare pe host partajat; fără izolare thermal, cache flush sau cache-hit counters.
- Trits sintetice LCG seed `0x5eed + case index`, valori -1/0/+1; activări int8 incluzând -128 și +127. Weight scale=0.25, activation scale=0.125, produs=0.03125.
- Referința densă păstrează exact aceiași trits int8, layout `[in,out]`, acumulare int64 și `float32(acc) * (activationScale * weightScale)`. Comparație bit-identică float32, nu toleranță arbitrară și nu comparație cu BLAS/SIMD optimizat; referința densă nu repetă validarea API a snapshotului.
- Matrice/vector/dst/encoded buffers sunt pregătite în afara buclei hot. NewSnapshot, ParseSnapshot, Pack și Unpack sunt măsurate separat.
- Artefacte numai în [Temp deținute](C:/Users/abel/AppData/Local/Temp/nexus-packed-baseline-bc4ccc5a673244b4aad7941b623bdeee/main.go): main.go, go.mod cu replace local către Ilaria, baseline.exe, results.json, build.json, source-before.json și cache-uri locale.
- Din acel Temp: setează GOWORK=off, GOPROXY=off, GOTOOLCHAIN=local, GOSUMDB=off, GOAMD64=v1; GOCACHE/GOTMPDIR/GOMODCACHE/TEMP/TMP către subdirectoarele sale. Compilează cu GOMAXPROCS=2: `"C:/Program Files/Go/bin/go.exe" build -p 2 -mod=readonly -trimpath -o baseline.exe .`; rulează baseline.exe cu GOMAXPROCS=1 și capturează stdout în results.json. Nu se descarcă dependențe.
- Harness SHA256: `d679002bdbb632e7fd432110d0f0225ae078deb08c9d8315ec390db5779355bc`; results.json: `4b58727399f4d59d41eb358ac538142f20a00ef89e37faae3160b5fad70eb991`.

## Rezultate hot: mediană µs/apel, 9 eșantioane

| In×Out | Snapshot bytes (payload+88) | Dense int8 bytes | Packed µs | Dense µs | Packed/dense |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1×1 | 92 (4+88) | 1 | 0.0135 | 0.0052 | 2.60× |
| 1×19 | 92 (4+88) | 19 | 0.110 | 0.0398 | 2.77× |
| 1×20 | 92 (4+88) | 20 | 0.116 | 0.0423 | 2.73× |
| 1×21 | 96 (8+88) | 21 | 0.121 | 0.0431 | 2.80× |
| 7×13 | 108 (20+88) | 91 | 0.431 | 0.1085 | 3.97× |
| 64×127 | 1,716 (1,628+88) | 8,128 | 37.00 | 9.048 | 4.09× |
| 256×257 | 13,248 (13,160+88) | 65,792 | 297.18 | 67.04 | 4.43× |
| 512×512 | 52,520 (52,432+88) | 262,144 | 1,196.13 | 379.42 | 3.15× |
| 768×768 | 118,056 (117,968+88) | 589,824 | 2,848.56 | 739.36 | 3.85× |
| 2048×1024 | 419,520 (419,432+88) | 2,097,152 | 10,240.70 | 5,259.05 | 1.95× |

Packed a fost mai lent în toate formele măsurate. La forma mare snapshotul encoded este circa 5× mai mic decât trits dense int8, dar aceasta nu este reducerea RAM total al unui model/proces.
La 2048×1024 packed min–max = 9,988.5–10,770.6 µs. Repetiții/eșantion: packed 4, dense 8, pack/unpack 16; formele mici au loturi mult mai mari. Tabelul nu pretinde nanosecunde exacte pentru apeluri individuale.

## Setup, stocare și alocări

- La 2048×1024: primul NewSnapshot=2,236.9 µs; primul MatVec=10,996.1 µs. Sunt primele apeluri ale acelei forme, nu probe cu cache demonstrat rece; primele apeluri foarte mici sub rezoluția ceasului sunt neconcludente.
- Mediane setup pentru aceeași formă: NewSnapshot=2,379.37 µs; ParseSnapshot=425.68 µs; Pack=2,092.97 µs; Unpack=2,341.99 µs. Repetiții new=16, parse=64/eșantion; separate de hot MatVec.
- `testing.AllocsPerRun(3)` după warmup: MatVec packed/dense, Pack și Unpack = 0 alocări/apel în toate formele; NewSnapshot și ParseSnapshot = 3 alocări/apel. Nu sunt valori B/op sau peak RSS.
- Encoded bytes includ headerul versionat de 88 B, inclusiv hash/dimensiuni și weight scale FP32 de 4 B. Activation scale FP32 de 4 B este argument separat; nu îl adăugăm încă o dată în header. Payload exact `4 * ceil(N/20)`.
- Hărțile dense/snapshot/encoded copy/vector/dst coexistă în harness; encoded bytes nu reprezintă working set. RAM/VRAM/RSS, energie/Joules/token, baterie și compatibilitate telefon: **unmeasured**.

## Verificări și o singură seam propusă

- PASS: 41 forme `[1,1..41]` acoperă toate cozile base-3 și frontierele de 20; MatVec direct și după ParseSnapshot sunt bit-identice cu referința. Cele 10 forme din tabel verifică și Pack/Unpack roundtrip.
- PASS: 33 refuzuri de API pentru layout/version/reserved/hash/truncare, trits/word/padding/lungimi necanonice, scale NaN/Inf/zero/negative și produs scale overflow/underflow, bounds/nil, limite dimension/trits/payload/snapshot, produs dimensiuni overflow și limita sigură de acumulare int64. Fără alocări de matrici gigantice pentru aceste cazuri.
- Toate cele 8 fișiere publice package `.go` + README au SHA identic înainte/după; manifestul complet este în source-before.json. MatVec SHA `c78adeba12267ca63ed8887b99bba429dbd6f244836bb93780c5a4f2857c8924`; codec SHA `a8cc02fadd4ecb9c9a6bc5c19f680184ea2462c92ed48b821cdf190712e2b1ce`; format SHA `da3466cbb2772af4ef17fb41a8f85998f8978388db9f0d884824c352cf04a073`.
- Compute bounded: prima compilare 11.292 s + primul probe nepublicat 0.927 s + recompilare 0.776 s + măsurare calibrată 23.852 s = aproximativ 36.85 s wall cumulat; fără suite de produs, training sau joburi de model.
- **PROPOSED numai:** în worktree viitor, prototypează decodarea unui word base-3 o singură dată pe tile, cu acumulatoare int64 locale bounded, păstrând layout, exactitate, limite și zero heap allocations. MatVec actual reîncarcă word și face divizie după powersOfThree pentru fiecare trit într-o traversare strided pe output; aceasta este seam observată, nu câștig demonstrat și nu justifică extinderea întregii matrice dense.
- Gate viitor: aceleași fixtures/invalid cases, exact output și benchmark hot/setup/alloc la bytes fixe, apoi IMC packed complet + calitate end-to-end într-o etapă separată. Această măsurare nu dovedește inferență transformer, antrenare IMC-1B sau funcționare pe telefon.

Validation report-only: ≤70 linii, whitespace și git diff --check; toate outputs de build/probe rămân în Temp. Claim nou unic, stop la handoff.
