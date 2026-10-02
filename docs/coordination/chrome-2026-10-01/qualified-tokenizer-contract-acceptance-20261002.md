# Contractul tokenizerului pilotului H200 — acceptanță de cod

Verificat la 2 octombrie 2026. Goalul integral Nexus + Swypik rămâne ACTIVE.
Acest raport acceptă lotul de cod; datele reale și alocarea GPU rămân necalificate.

Au fost integrate numai cele patru claims din worktree-ul dedicat, după
STOP/handoff și review independent. Contractul separat leagă explicit freeze-ul,
sample-ul, coverage-ul, drepturile existente, sursele, atestările first-party,
proveniența și inventarul artefactelor excluse. Calea v1 cu grupuri exclusiv de
antrenare rămâne disponibilă cu aceleași reguli. Nu există fallback implicit.
Trainerul, familia IMC și arhitectura canonică nu au fost înlocuite.

Review-ul a respins prima versiune înainte de integrare: tokenizerul și fișierul
său auxiliar puteau fi aliasuri ale unor artefacte excluse. Șapte teste au
reprodus problema înainte de corecție; versiunea reparată verifică hashuri,
paths și hardlinkuri înaintea citirilor și a fost revizuită independent.
Prima versiune, testele RED și toate receptele anterioare sunt păstrate.

Verificări în Main: **334 teste Python trecute, un test Windows exclus**, syntax,
`GOWORK=off go test ./...`, `go vet ./...` și verificările whitespace.
Cele 33 de surse protejate, HEAD, branch-ul și indexul Git au rămas identice.
Nu s-au făcut stage, commit, reset, clean, push, deploy sau publicare.

O probă nouă a folosit intrarea canonică și Supervisorul real Linux CPU/Gloo:
**două procese, două actualizări, 16 tokeni globali, 10,69 secunde**. Bindingurile
contractului și ale atestării coincid în checkpoint, semnătură și metadatele
rulării. Nu s-a injectat admiterea sau supravegherea. Cleanup-ul confirmă ieșirea
celor trei identități de proces; citirea independentă ulterioară le găsește absente.
Aceasta folosește numai un model mic și fixtures sintetice NON_PROMOTABLE;
nu dovedește calificarea corpusului real, NCCL pe opt GPU-uri sau exportul cloud.

Copia externă a celor șapte surse first-party originale a trecut validatorul
canonic cu atestarea existentă. Checkout-ul curent nu a fost restaurat și
atestarea nu a fost rescrisă. Proveniența semantică, excluderile complete și
byte-urile tokenizerului real încă trebuie verificate independent.
Hashurile și identitățile de review nu dovedesc singure drepturile sau independența.

Catalogul Brev, interogat read-only la **04:58:30 UTC**, nu mai returnează
nicio opțiune cu opt H200, inclusiv în lista completă. Tipul observat anterior,
`excesssupply_H200x8`, costa 38,40 USD/oră pentru întreaga VM; prețul anterior
nu este o ofertă curentă verificată. Planul de 120 minute total ar costa 76,80 USD
la acel preț și ar păstra 23,20 USD din creditul autorizat de 100 USD.
Prețul, disponibilitatea și condițiile trebuie reconfirmate înainte de alocare;
nu a fost creată nicio VM sau cheltuială cloud nouă.

Urmează verificarea datelor și excluderilor reale, exportul și ștergerea instanței
independent de calculatorul local, apoi bootstrap-ul CUDA/NCCL și alegerea
numărului de pași pe throughput măsurat, în bugetul total autorizat.
ChatGPT Bridge, G4, modelele globale și cheile nu au fost modificate.

Receptele, comenzile, logurile și backupurile sunt în
`E:\nexus-training\evidence\qualified-tokenizer-contract-20261002`.
Receptele first-party sunt în `first-party-source-readback-20261002`.
