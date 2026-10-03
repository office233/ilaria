# Pilot H200: surse pregătite, alocare încă blocată

Root a acceptat selectiv 15 claims din trei worktrees dedicate: adaptorul pilotului
IMC, supervisorul Linux și proba de revocare P2P. Branch, HEAD, index și staged=0
sunt păstrate; alte 373 de intrări publice nu au drift. Schimbările existente din
Nexus și aplicația Swypik rămân păstrate. Nu s-a făcut commit/push/deploy.

## Comportamentul verificat

Trainerul canonic acceptă un pilot code-only separat, NON_PROMOTABLE, legat de
identități și drepturi explicite, grupuri train/validation/sealed, tokenizer și
bugete globale de pași/tokenuri/timp. Metadatele PENDING sunt respinse înainte de
streamuri/resurse. Sealed nu este încărcat pentru training. Sursa supervisorului
este verificată, iar fiecare rank trebuie să dovedească apartenența la scope-ul
live prin credențiale kernel și identitatea exactă a workerului/argumentelor.
Resume-ul pilotului rămâne refuzat până există un receipt complet al invocării
precedente; verificarea strictă pentru production resume rămâne în vigoare.

Supervisorul închide și reapă procesele detașate/reparentate, inclusiv când
launcherul sau coordonatorul dispar. Folosește subreaper Linux, pidfds, identități
reținute, deadline cumulativ și rezervă de cleanup. Nu este un sandbox pentru cod
ostil și nu garantează cleanup după SIGKILL al helperului sau task kernel blocat.

Proba P2P unică a trecut în 12,515 s. După primul backward/optimizer.step IMC real,
revocarea a oprit workerul natural în aproximativ 63 ms, în hold-ul diagnostic
explicit de maximum 1000 ms. Nu s-a adoptat un checkpoint sau schimbat progresul.
Cele 18 identități urmărite s-au încheiat; readback-ul ulterior a distins și un PID
reutilizat de altă identitate. Numai Windows CPU, loopback și fixture sintetic;
rezultatul nu este hard real-time sau dovadă de preempție CUDA.

## Gates și probe păstrate

- Main Ilaria: 387 teste Python PASS, 8 native Linux SKIP pe Windows; cele 8 native
  au trecut separat în Linux, pe aceleași surse integrate. Ilaria Go: 12 pachete
  PASS, 4 fără teste; vet PASS.
- Main OS: 55 pachete PASS, 8 fără teste; vet PASS. Phase/runner: 58 Python PASS.
  Compile, tracked whitespace și toate cele 15 claims no-index: PASS.
- Prima probă nativă Main a avut 7 PASS și un eșec de fixture: launcherul era oprit
  între crearea și scrierea PIDfile. Corecția test/handoff verifică direct kernel
  ECHILD și exit/reap, fără acea comunicare fragilă. Retestarea Main: 8 PASS/10,40 s.
- Eșecul inițial, mutațiile RED și cele 11 eșecuri legacy Linux cauzate de biblioteca
  Torch absentă sunt păstrate. Testele CPU cu supervision injectat și probele
  Linux de control nu constituie împreună un pilot canonic Linux efectiv verificat.

Evidence durabil: `E:\nexus-training\evidence\supervision-p2p-admission-20261002`.
`final-acceptance.json` SHA256
`65e038255c07c4159f9ab4b2f0e92f31dea96856fbe907c47e96409575f5d964`;
snapshotul celor 15 surse publice, manifest SHA256
`13c0aea1aa28115f356af41af9e2cbea3e334bcedb594a13ce407b5737d6fd77`.
Snapshotul și backupurile nu conțin tensori sau date private.

## Următoarele gates înainte de cheltuială

1. Verificare independentă a byte-urilor/provenienței pachetului real și aprobarea
   explicită a calificării, deciziei și bugetelor. Identitățile așteptate ale celor
   486 de grupuri au fost recuperate și verificate, dar apartenența corpusului
   efectiv nu este încă demonstrată. Pachetul frozen și template-urile PENDING
   nu au fost modificate.
2. Proveniența tokenizerului real: contractul actual cere grupuri din train și
   aceleași source locks. Un tokenizer universal frozen din alte surse aprobate
   necesită un contract separat verificat. Nicio aprobare nu se deduce din hash.
3. Proba canonică Linux cu Torch și supervision live, apoi preflight GPU/NCCL cu
   opt rankuri și throughput măsurat, în fereastra plătită autorizată.
4. Preț/sold/Terms/fereastră actualizate și mecanism de export + ștergere verificat
   independent de PC. Oprirea trainerului nu oprește facturarea VM-ului.

Ultimul `brev ls --json`, 03:29:58 UTC, a întors `workspaces:null`, exit0. Nu a fost
alocată o VM. Planul rămâne o VM cu 8 H200, maximum 100 USD și 120 minute facturabile
totale: la prețul observat de 38,40 USD/oră, 76,80 USD compute și 23,20 USD rezervă.
Prețul necesită refresh înainte de alocare; acestea sunt estimări și limite locale,
nu o garanție a facturii. Fereastra veche expirată nu a fost prelungită implicit.

Goal-ul integral rămâne ACTIVE. ChatGPT Bridge, G4 și secretele sunt neatinse;
nicio antrenare cloud, cumpărătură nouă sau nou prompt OpenCode plătit.
