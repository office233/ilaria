# Acceptanță verificată — Ilaria, P2P și Swypik

Verificat la 2 octombrie 2026, 02:20 UTC / 05:20 Europe/Bucharest.
Goalul integral rămâne ACTIVE. ChatGPT Bridge este neatins.

Au fost integrate selectiv 31 de fișiere publice: 15 în Nexus și 16 în aplicația
originală `E:/Swypik/swypik-mobile-pilot`. Implementările au fost pregătite în
worktrees dedicate, cu claims separate, handoff și review înainte de transfer.
Nu s-a copiat un overlay complet. Branchurile, HEAD, indexurile și staged=0
au rămas identice; 345 de alte intrări publice protejate nu au drift.
Fișierele înlocuite au copii de siguranță în evidence, fără reset/clean/commit.

## Ce s-a schimbat

- Trainerul canonic verifică streamurile, tokenizerul și manifestul înainte de
  CUDA, inițializarea DDP, model și optimizer. Intrările invalide se opresc
  înainte de această alocare. Familia IMC și contractul strict de checkpoint
  rămân neschimbate; o schimbare de hash a trainerului nu autorizează un resume
  incompatibil. Verificarea datelor consumă în continuare CPU/I/O.
- Gate-ul de calificare distinge explicit pilotul de cod NON_PROMOTABLE de
  corpusul de producție. Leagă identitățile, proveniența, rights evidence,
  grupurile disjuncte, validarea independentă și limitele experimentului.
  Este verificare de metadate, nu autoritate de aprobare sau adaptor de trainer.
- Nodul P2P monitorizează acordul la interval configurabil 10–1000 ms,
  implicit 100 ms. Pierderea acordului anulează contextul socketului și Job-ul
  workerului. Păstrează cauza anulării, eroarea callbackului și primul rezultat
  Close; o eroare de cleanup nu este raportată ca oprire verificată.
- Aplicația are fluxul Ilaria prin protocolul Myriad și gateway-ul OS, fără
  duplicarea modelului. Clientul reverifică deadline-ul înainte de succes și
  anulează cererea corelată. Gateway-ul refuză noi inferențe când închiderea
  workerului este incertă. Acordurile compute/date sunt distincte și oprite
  implicit; backendul actual nu execută training de la telefon.

## Dovezi

- Trainer/dataset/tokenizer: 243 de teste afectate PASS în worktree, inclusiv
  testele IMC și checkpoint/resume CPU; 15 cazuri discriminatorii au eșuat
  înaintea corecției și trec după. Main: 47 de teste admission/qualification PASS.
  Ilaria: 12 pachete Go și vet PASS. Copierea exactă și dependențele sunt verificate.
- Main după integrare: 55 de pachete OS PASS, 8 fără teste, vet PASS; aplicația
  originală: 96 de teste fără skip, typecheck și lint PASS; provider: 32 PASS
  și py_compile. Git diff --check și verificarea whitespace a tuturor celor
  31 de fișiere acceptate PASS. Verificarea no-index dezactivează numai avertizarea
  safecrlf pentru invocare; nu modifică configurația Git sau octeții fișierelor.
- P2P: 11 funcții noi și cinci mutații RED discriminatorii verifică anularea
  workerilor sintetici reali, socketul blocat și propagarea erorilor de cleanup.
  Monitorizarea este polling, fără garanție de timp real sau atomicitate între
  citirea acordului și un efect. Verificările sincrone înainte de efect rămân.
- Proba Main TCP cu IMC canonic sintetic PASS în 36,469 s: rollback semnat la
  secvența 4, procese noi, acceptări 5/6 și reject 7; progresul durabil coincide
  la ambii peers, iar replay-ul este refuzat înainte de alocarea workerului.
  Șase procese directe și drains încheiate; opt PID-uri observate absente,
  301 hashuri publice fără drift. Prima încercare a eșuat la startup din cauza
  căii cryptography indicate greșit de root; a fost păstrată și nu a antrenat.
- Proba mobilă finală în forkuri, cu aceleași 20 surse și 47 dependențe acceptate:
  TLS → IMC aleator real, patru forwards, anulare după pornirea workerului,
  PASS în 3,375 s. Șapte procese cu identități păstrate au ieșit; Job activ=0,
  handles închise. Review-ul independent a verificat hashurile și RED/GREEN.
  Integrarea pe Main a repetat gates-urile afectate, fără inferență inutil repetată.

Evidence durabil: `E:/nexus-training/evidence/reconciled-main-20261002`.
Receipt final: `final-acceptance-receipt.json`, SHA256
`aa3004c77f841460576d2c56343c7af8c15531a04901536b459a5003efadb112`.
Receipt P2P: `main-p2p-actual/bounded-tcp-ww46ospd/receipt.json`, SHA256
`b1d63275b421478e576197290d9ea9f383d7f0e917afd545ca27589a0dec6c7a`.
Receipt owner mobil final: `E:/nexus-training/evidence/mobile-reconciliation-20261002/whitespace-final/owner-stop.json`,
SHA256 `9a7ffcf00c3a52f94f205cbd4855c6bf43945d91dc8df8f57dd8a43338f3ec7f`.
IMC canonic: `650f4cad06d80760a03fa4396bb2cce27364bd596b8002f39ec02d595205274c`.

## Brev: configurație pregătită, fără VM creată

Dry-run CLI verificat: o singură VM `excesssupply_H200x8`, 8 H200,
provider SHADEFORM, count=1 și parallel=1. Cotația totală observată la 01:14 UTC
este 38,40 USD/oră. Planul limitează durata facturabilă totală la 120 minute,
incluzând provisionarea, bootstrap, training, export și ștergere:
76,80 USD compute estimat + 23,20 USD rezervă din cei 100 USD autorizați.
Prețul și condițiile trebuie reverificate înaintea alocării; soldul/factura și
auto-recharge nu sunt verificate. Planul nu este un plafon impus de furnizor.

Readback CLI la 01:45:41 UTC: workspaces:null; fără alocare/training plătit.
Cutofful vechi a trecut; noua fereastră și acceptarea termenilor consolei sunt
întrebări umane deja pendinte. Nu se extind prin simpla prezență a PC-ului.
Oprirea trainerului/PC-ului nu închide facturarea VM-ului: exportul cu hashuri
și ștergerea independentă de host trebuie verificate înainte de launch.
[Documentația oficială Brev](https://docs.nvidia.com/brev/cli/instance-management).

Pachetul de cod frozen are aproximativ 33,85M tokeni train, 7,91M validation și
14,70M sealed, NON_PROMOTABLE; nu este întregul corpus Genesis cu opt lane-uri.
Calificarea efectivă încă are grupurile/receipt-ul independent/limitele/decizia
pendinte și adaptorul către trainerul canonic lipsește. Nici CUDA/NCCL real pe
8 GPU, nici exportul și watchdog-ul de ștergere nu sunt certificate.

## Următoarele praguri

1. Calificarea pilotului cu metadate reale și adaptor canonic strict, fără
   relaxarea rights/provenance sau amestecarea sealed în selecție/training.
2. Închiderea condițiilor Brev și proba 8-rank bounded; măsurarea throughputului
   stabilește pașii realizabili, cu timp rezervat exportului și ștergerii.
3. Revocare în timpul antrenării IMC reale și P2P pe două hosturi; agregare
   robustă și evaluări sigilate/statistice, dincolo de datele sintetice mici.
4. Backend/auth/serving aprobat și APK/IPA verificat pe dispozitive. Pregătirea
   Android există separat; acceptarea SDK rămâne pending, fără build pretins.

Aceste probe nu dovedesc generalizare, model de producție, training mobil,
energie sau superioritate față de alte LLM-uri. Ownerii acestui lot sunt STOP;
relansarea cere scope nou și claims disjuncte. Goalul integral continuă.
