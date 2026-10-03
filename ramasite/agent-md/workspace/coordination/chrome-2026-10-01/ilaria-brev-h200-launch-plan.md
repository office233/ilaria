# Ilaria — Brev 8×H200, plafon total 100 USD

Stare verificată prin Chrome, 2026-10-01 21:02 UTC: pagina de creare afișează
o singură instanță `excesssupply_H200x8`, 8 GPU H200 cu 141 GB VRAM fiecare,
SHADEFORM, 38,40 USD/oră **total**, SSD fix 30 TB inclus în preț. Provisionarea
anunțată este 12m30s. Nu am apăsat Deploy și nu am creat o instanță.

Plafonul utilizatorului este 100 USD total. La tariful observat, 120 minute
de instanță, inclusiv provisionarea, costă estimativ 76,80 USD; păstrăm
23,20 USD rezervă. Durata este scurtată de termenul de ștergere operațională
2026-10-01 22:30 UTC / 2026-10-02 01:30 România, înainte de oprirea PC-ului
anunțată pentru 02:00. Reconfirmăm tariful și minutele rămase la alocare.

Oferta afișează «No stop/start»: oprirea trainerului sau a PC-ului nu închide
facturarea. Pagina avertizează că epuizarea creditelor șterge instanța și toate
datele ei. Starea AutoRecharge nu este verificată. Nu folosim aceste mecanisme
ca protecție de buget; trebuie verificată ștergerea instanței și exportul în afara
VM-ului înainte de o alocare plătită. Nu cumpărăm alte credite sau planuri.

## Date și software

Downloadurile noi sunt reale: 171.192.809 tokeni diagnostici IlariaLex + EOS.
Această sumă nu este un stream de training și nu certifică valoarea pedagogică.
Codul FreeRTOS/Zephyr are 17.518 corpuri unice, 56.980.501 tokeni diagnostici,
licențe și versiuni verificate. Din el este pregătit acum un pilot de cod înghețat:
33.852.096 tokeni train,7.907.468 validation,14.701.949 sealed,486grupuri conectate,
46documente cu suprapuneri lexicale la benchmark excluse, streams canonice și
validare read-only PASS. Acest pilot NON_PROMOTABLE nu este fullGenesis.
Cele 56.987 fragmente de cărți (43.110.627 tokeni)
și cele 23.252 transcripturi românești (1.709.030 tokeni) rămân în carantină
până la închiderea verificării drepturilor. OpenMath nou adaugă7151exemple/
69.392.651tokeni diagnostici, text integral, replay și recount independente PASS;
obligațiile AoPS/MATH încă deschise mențin carantina. Nu le promovăm prin schimbarea unui
flag și nu reutilizăm corpusul/checkpointurile pilotului Colab protejat.

Trainerul canonic are DDP, RNG per rank și checkpoint/resume. Testele CPU/Gloo
și verificarea argv nu dovedesc 8×H200 CUDA/NCCL. După alocare, primul consum
plătit este un bootstrap scurt, limitat: `gpu_preflight.py --world-size 8
--min-vram-gib 80 --min-compute-major 9 --require-bf16
--require-name-contains H200`, apoi forward/backward/checkpoint/resume canonic
pe 8 rankuri și măsurarea throughput-ului. Microbatch/accumulation trebuie să
păstreze global batch-ul rețetei. Bugetul de pași se decide din această măsurare,
cu timp rezervat pentru checkpoint/export și ștergere. Nu promitem terminarea
IMC-1B sau un număr de tokeni fără această probă. IMC-125M rămâne etapă de
validare, aceeași familie IMC antrenată de la zero.

Manifestul vechi `training-gates-v1/dataset.manifest.json` există; lipsa unui
manifest generic implicit nu înseamnă lipsa tuturor manifestelor. Noul pachet
trebuie să aibă propriul manifest și lineage, distinct de pilotul finalizat.

## Pasul de lansare

Există un pilot cod frozen, nu încă mixtura completă de producție. Guardul remote
de ștergere și exportul sunt neverificate. Acestea sunt blocante
concrete ale alocării, nu lipsa autorizației de buget.
Pagina Deploy include acceptarea transmiterii datelor personale/deployment către
SHADEFORM conform termenilor Brev. Confirmarea acestei acceptări se cere numai
când pachetul și planul de ștergere sunt gata pentru review, înainte de Deploy.
Setările de hardware pot rămâne pregătite fără a începe facturarea.

Cercetarea read-only a CLI-ului oficial Brev, commit
`7ebb7186854ac16b2e7634a8f9f8a984fcf8c5cb`, nu găsește TTL/max-duration la
creare. `--timeout` limitează doar așteptarea pentru Running. `brev delete
<INSTANCE_ID>` cere terminarea, cu readback obligatoriu. CLI v0.6.335 a fost
instalat/verificat din release-ul oficial, cu checksum vendor, în
`/home/abel/.local/share/nexus-task-tools/brev-0.6.335-20261001/brev`.
Această versiune copiază directoare automat, fără flagul `-r` din exemplul
documentației: `brev copy <NAME>:/home/ubuntu/workspace/outputs <DEST>`, opțiune
`--host` când ținta este fișierul hostului. Exportul necesită acces SSH configurat.
Autentificarea prin API key nu pregătește SSH. Controllerul, accesul și exportul
nu sunt încă verificate pe această ofertă; nu inventăm un autostop. Proba
`ls --json` a confirmat lipsa unei sesiuni CLI autentificate existente; niciun
login/OAuth, API key nou, profil/PATH sau permisiune nu a fost modificat în acea probă.
La 21:56 UTC, root a finalizat autentificarea normală NVIDIA a CLI-ului oficial
în organizația deja deschisă în browser; `brev ls --json` a terminat cu exit 0
și `workspaces: null`. Nu a fost creată nicio instanță. Receipt fără secrete:
`E:\nexus-training\evidence\brev-cli-preflight-20261002\receipt.json`.
Autentificarea nu dovedește exportul sau ștergerea unei VM reale.
Surse: [creare](https://docs.nvidia.com/brev/cli/instance-creation),
[gestiune](https://docs.nvidia.com/brev/cli/instance-management),
[export](https://docs.nvidia.com/brev/guides/development-tools/file-transfer-scp).

Configurația operațională este `ilaria-brev-h200-budget-1.json`.
