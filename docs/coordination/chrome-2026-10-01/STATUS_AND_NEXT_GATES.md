# Nexus + Swypik — rezultate și următoarele probe

Snapshot actualizat: 2 octombrie 2026, 00:09 UTC. Obiectivul complet rămâne ACTIVE în GOALS.md.
Acest tabel separă rezultate verificate, lucru activ și funcții încă nelivrate.

Pachetul de proveniență curator/manifest este integrat; loturile noi verificate
sunt frozen în carantină. Noua antrenare H200 nu este lansată. Main P2P are acum
prototip TCP loopback probat: două runde legate acceptate, reject/replay și
continuare reală după restart până la seq6. Rollback separat restaurează hashul,
dar rollback→resume rămâne refuzat. Acceptanță/limite: p2p-tcp-main-acceptance.md.
Nu se declară Internet P2P sau antrenare distribuită125M funcțională.

| Componentă | Dovadă existentă | Ce trebuie închis |
|---|---|---|
| Ilaria IMC-125M | Model propriu; fiecare variantă3815updates/1.000.079.360tokenuri; FP bestCE2.048409, ternary2.175886; ambele NOT_PROMOTED. | Evaluări de utilitate/cod/matematică, alte seeduri și curbe calitate/resurse înainte de promovare/scalare1B. |
| Învățare locală | Două procese, actualizare canonică, evaluator independent, adoptare/replay/reject/rollback; fixture sintetică16-token. | Nu demonstrează antrenare distribuită125M, rețea publică sau îmbunătățire automată cu numărul de utilizatori. |
| Rețea continuă | Main:19claims integrate; două procese OS/loopback TCP, accept/reject/replay, issuer-signed progress și restart seq4/5/6, bytes/CPU/RSS și cleanup măsurate. | Rollback→resume coerent, crash/dropout/revoke în timpul calculelor, două calculatoare și Internet; evaluare/statistică și125M distincte. |
| Runtime comprimat | TritPack20 are codec/operator CPU și acumulare întreagă; Forge păstrează ponderi latente/stări optimizer. | Kernel măsurat înainte/după, export/transformer packed complet și runtime mobil; memoria ponderilor nu este RAM totală. |
| Swyp Lang | Parser/checker/CoreIR/contracts/capabilities/build determinist, independent de model; gates acceptate. | Fluxuri de produs și comparații de corectitudine/utilitate; nu rescriere integrală automată a ecosistemului. |
| SwypikOS | ControlKernel/capabilități și kernel/probe host acceptate. | Boot/drivere/concurență pe hardware și matrice de suport; încă nu OS universal instalabil. |
| Swypik iOS/Android | Auth/lifecycle/config,105teste, Androidsource și exports Hermes verificate în worktree. | JDK/SDK/Gradle build Android, iOS toolchain/build, dispozitive/backend; exports JS nu sunt APK/IPA. |
| Ilaria în Swypik | Scope cerut explicit și inclus în GOALS8/9; preflight de integrare în lucru. | Inferență reală și contribuție opt-in a aplicației, protocol canonic, consent/revocare/evaluare și bugete mobile; nu există încă training mobil activ. |
| Multimodalitate | Plan documentar și seams identificate. | Encodere/conector proprii, date aprobate, antrenare și evaluare distincte; nu există model multimodal validat. |
| Checkout CI | Gate/wiring remediate,56teste și verificări de workflow PASS. | Gate Main rămâne FAIL cu4inputs neindexate; nu declarăm checkout GitHub reproductibil până la includerea autorizată în Git. |

## Cele cinci riscuri cerute — probe concrete

1. **Calitate ternară:** comparăm aceeași arhitectură/date/tokenuri cu controlul,
   CE și ancore de utilitate; pilotul actual favorizează FP la CE, fără verdict
   general. Nu presupunem că mai mulți parametri/noduri repară automat diferența.
2. **Memorie de antrenare:** inventar real dtype/params/grads/optimizer/activări;
   roluri pe dispozitive capabile, adaptoare doar după validare. Masterweights
   pot sta pe workers autorizați; nu impunem un server central prin definiție.
3. **Telefon/hardware:** benchmark nativ cu RAM totală/startup/p95/thermal/baterie,
   nu deducție din1.58bits sau codec. Folosim platformele suportate și cooperare
   explicită, fără promisiunea de background permanent pe iOS/Android.
4. **Multimodal:** alegem o primă modalitate și măsurăm separat encoder/conector/
   textmodel; precizia mixtă este candidat experimental, nu funcție existentă.
5. **Dropout:** după gate-ul de rețea, cohortă cu25/50/90%disponibilitate pierdută,
   deadlines/reassignment idempotent/current-parent/replay/backpressure, fără
   publicare duplicată sau blocarea inferenței. Fixtures sintetice publice.

## Ordinea execuției

Închidem rețeaua cu probe reale; optimizăm operatorul CPU pornind de la baseline;
pregătim integrarea aplicației și buildul nativ; apoi escaladăm modelul numai
după evaluări/bugete. Creșterea capacității/experților este experiment separat:
DiLoCo sincronizează aceeași arhitectură, nu adună parametrii dispozitivelor.

Securitatea include autorizare/replay/versionare/evaluare independentă și
threat model; XOR/signatures/TEE nu garantează singure munca sau calitatea.
Datele personale rămân locale implicit. Fără criptomonede sau stimulente crypto.
CPU/TDP nu devin joules: energia rămâne UNMEASURED până la contoare reale.

Dovezi: p2p-main-acceptance.md, public-checkout-main-acceptance.md, LIVE_STATE.md,
ilaria-multimodal-efficiency-plan.md și ilaria-colab-hardware-plan.md.

## Probe noi acceptate — 2026-10-01 21:11 UTC

Benchmarkul nou p2p_quality_adversarial importă evaluatorul canonic cu trei
source SHA pins, fără implementare duplicată. Delta reală inversată înrăutățește
CE3,2246127→3,7840199 și este respinsă. Gradientul care îmbunătățește CE la
3,0659785 dar reduce anchor accuracy0,03125→0 este de asemenea respins. Ambele
restaurează metricile active și nu emit checkpoint; nu sunt probe de rețea ori
generalizare. Main3teste PASS, inclusiv no-clobber receipt, runner verificat și
cu python -O. Nicio editare a celor15claims P2P acceptate/OC3 NETWORK.

Main14fișiere bench noi integrate după handoff,206inputuri protejate neschimbate,
21teste noi și git diff --check PASS. Provocările de selecție/acceptare pe seturi
separate mari și praguri statistice rămân deschise. Date noi101.800.158tokeni
diagnostici verificate în receiptul acquisition-root-review, nu încă fullGenesis.
Buget Brev100USD total/8H200, fără instanță creată; guard delete/export și
pachetul frozen sunt încă cerințe înainte de alocare.

## Follow-up audit P2P și păstrare dovezi — 2026-10-01 20:35 UTC

- Cele15 surse publice acceptate au fost rehash-uite independent și coincid cu
  acceptanța13:43. Copie separată în
  `E:\nexus-training\evidence\p2p-local-20261001-134335\public-source-snapshot`,
  cu manifest;18logs/metadata scalare,836.573bytes, sunt păstrate în parent.
  Nu au fost copiate checkpoints, state, chei ori tensorii modelului. Snapshotul
  local nu înlocuiește versionarea Git sau un backup pe alt dispozitiv.
- Simulatorul vechi este opt-in și marcat SIMULATED; fără configurație explicită
  ComputeMicroBatch refuză. Swarm returnează reward0 înainte de contabilizare
  pentru SIMULATED. Afirmația că această cale creditează coins este incompletă.
  Câmpurile istorice coins/reward/wallet rămân de retras din fluxurile de produs;
  nu confundăm autentificarea Ed25519 cu o criptomonedă activă. Crypto-money
  rămâne interzis prin Goal.
- Review-ul independent confirmă lipsa probelor explicite pentru sign-inverted
  delta și CE mai bun cu anchor accuracy mai rea în testele Main locale.
  Un owner separat poate implementa numai bench NOI pentru aceste quality gates,
  folosind evaluatorul canonic și fixture-uri sintetice, fără editarea claims
  OC3 NETWORK deținute. Aceste probe nu certifică transportul sau modele mari.
- Gate-ul demo cu un prag CE fix minuscul și aceleași evals pentru selecție și
  acceptare nu califică producția. La125M/1B sunt necesare holdout sigilat distinct,
  praguri calibrate/statistică, ancore de utilitate, mai multe seeduri și probe
  de regresie; CPU/RSS reale trebuie măsurate, nu deduse din caps.
- Comanda operatorului din acceptanța root folosește acum parametri fără paths
  personale. Reproducerea pe host curat și lockul dependențelor cu hashes rămân
  gates deschise; observația versiunilor instalate nu este un dependency lock.
