# SwypikOS — plan de execuție

27 septembrie 2026. Înlocuiește planurile istorice din arhiva externă.

## Direcție

Construim strict OS-ul. Ilaria este singurul model. Nexus deține inferența, tokenizerul, checkpointurile, antrenarea și evaluarea modelului. SwypikOS deține desktopul, fișierele, aplicațiile, permisiunile, istoricul și clientul de contribuție GPU. Fără catalog de model providers și fără bugete comerciale de tokenuri; limitele tehnice ale contextului și resurselor rămân necesare.

Îmbunătățirea automată a aplicației înseamnă modificare propusă, diff verificabil, teste, evaluare, versiune și rollback. Nu înseamnă modificarea automată a ponderilor sau publicarea necontrolată a schimbărilor.

## Etape și criterii de acceptare

| Etapă | Livrabil | Închidere |
| --- | --- | --- |
| 0. Curățare | Surse, binare, date și arhivă separate; build unic | Build și pornire verificate; date păstrate |
| 1. Stabilitate desktop | Audit fișiere, shell, browser, chat, settings; erori/anulare explicite | Succes, eroare, timeout și restart testate; fără panic în scenarii |
| 2. Ilaria reală | Contract Nexus, stare conectare, istoric limitat, anulare | Răspuns pe model real; serviciu absent/ocupat tratat corect; fără răspuns fictiv |
| 3. Simplificare | Inventar module/apelanți; eliminare simulări din fluxurile normale; separare componente mari | Eliminările au justificare și verificări de regresie |
| 4. Operații OS | Acțiuni structurate, scope workspace, jurnal, undo unde este posibil | Argumente validate; acces în scope; rezultat reflectă execuția reală |
| 5. Distribuție | Instalare, update verificat, rollback, diagnostic fără secrete | Instalare/upgrade pe Windows; rollback păstrează datele |
| 6. Azure | Coordonator separat: dispozitive, sarcini GPU, versiuni, artefacte | Auth, retry idempotent, backup/restore și observabilitate testate |
| 7. GPU voluntar | Client cu limite și oprire imediată | Sarcină reală Nexus validată; rezultat acceptat o dată; recuperare după deconectare |

Urmează etapele 1–2. Nu ștergem module doar după nume: unele prototipuri sunt importate de GDI și installer. Nu edităm simultan integrarea la care lucrează agentul Nexus.

## Contribuția GPU

Utilizatorul activează contribuția și poate opri workerul imediat. Setări: idle, alimentare, temperatură, putere, VRAM, trafic și spațiu. Fișierele personale și conversațiile nu devin automat date de antrenare.

Protocol propus: dispozitiv autentificat → manifest de sarcină versionat/semnat → verificare hardware → execuție izolată și limitată → rezultat cu hash → validare Nexus → muncă acceptată. Tratăm expirare, duplicate, retry, checkpoint și revocare. Actualizările nevalidate nu intră direct în model.

Raportăm secunde GPU măsurate și muncă acceptată, separat de estimări. Monedele și contoarele existente sunt istorice/simulate. Formula contribuției se stabilește după măsurarea lucrului util.

8 H200 prin Brev reprezintă infrastructura principală planificată. GPU-urile utilizatorilor nu formează automat un cluster sincron echivalent. Nexus definește sarcini potrivite pentru hardware și rețea; OS implementează clientul.

## Calitate măsurabilă

Baseline reproductibil: pornire, memorie, latență UI, erori, recuperare după crash și succesul sarcinilor. Pragurile se stabilesc pe hardware declarat. Compararea cu alte aplicații cere aceleași sarcini și rezultate măsurate.

Fiecare schimbare: problemă demonstrată, modificare limitată, verificare relevantă, limite documentate. Înaintea release-ului public: versionare Git, CI, teste end-to-end Windows și update/rollback. Folderul local nu avea repository Git la audit.
