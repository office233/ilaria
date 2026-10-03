# Procesele terminalului — implementare și verificare

27 septembrie 2026. Executorul Windows folosește acum Windows Job Objects.

## Comportament

1. Creează un job anonim, cu terminarea proceselor la închiderea ultimului handle.
2. Creează cmd.exe suspendat, fără fereastră de consolă. AutoRun este dezactivat prin /d.
3. Construiește de la zero environment-ul copilului dintr-o allowlist fixă de variabile Windows/toolchain (`SystemRoot`, `PATH`, directoare temporare/cache/config și câteva locații standard). `ILARIA_API_TOKEN`, API keys, token-uri și variabile necunoscute nu sunt moștenite implicit.
4. Limitează handle-urile moștenite la stdin și outputul comenzii.
5. Asociază shellul jobului înainte de prima instrucțiune, apoi îl reia.
6. Capturează outputul în limita existentă de 256 KiB.
7. La anulare sau la încheierea shellului închide jobul și așteaptă terminarea procesului și citirea outputului.

Dacă asocierea cu jobul eșuează, comanda nu este executată. Codul de ieșire nenul produce eroare. Timeoutul rămâne 30 secunde; contextul HTTP poate anula comanda mai devreme.

## Verificări reale

- Anularea shellului oprește procesul copil de test.
- Un părinte care se încheie normal nu lasă copilul să ruleze în fundal.
- Opt comenzi concurente au output separat.
- Un handle de eveniment moștenibil din procesul de test nu ajunge la comandă.
- `ILARIA_API_TOKEN`, un sentinel secret și o variabilă părinte necunoscută nu ajung în environment-ul copilului; `process.run` verifică același traseu integrat și păstrează `SystemRoot` disponibil.
- Ghilimelele, directoarele cu spații și codul de ieșire 7 sunt tratate corect.
- Verificări executate pe Windows amd64 cu race detector și pe Windows 386 fără race detector.

Testele creează doar procese și fișiere proprii; nu opresc procese identificate doar după nume. Implementarea nu adaugă un serviciu sau un executabil helper în produs.

## Limite explicite

Runda completă după integrare: **118 cazuri Go trecute, 4 teste JavaScript și 11 scenarii Edge trecute**, go vet și build reușite. Un test live Ilaria rămâne skipped. Acoperire Go: 64,3%. Artefacte: `C:\Users\Pos5\AppData\Local\Temp\swypik-verification-d46a802a10124dadb397ac86770d4a72`.

Acesta este **secret/process hardening**, nu AppContainer/restricted-token sandbox. Comanda păstrează permisiunile utilizatorului și poate în continuare citi fișierele/registry-ul accesibile contului sau folosi rețeaua; allowlist-ul de environment închide doar moștenirea implicită de secrete din parent process. Nu există încă un secret broker / registry de valori cunoscute, deci nu se aplică o redacție generică de output care ar pretinde protecție fără o sursă deterministă de adevăr.

Job Object-ul aplică în continuare `KILL_ON_JOB_CLOSE` și wall-time-ul este impus extern prin `context`. Nu sunt introduse în această etapă limite statice de process count, memorie sau CPU: `process.run` nu are încă un contract de bugete per comandă, iar plafoane globale arbitrare ar putea rupe build/test workloads legitime. Aceste limite trebuie legate de viitorul budget/capability broker și testate ca politică explicită înainte de activare.

Servicii externe cărora o comandă le cere să pornească alte procese nu devin automat membri ai jobului. Sarcinile persistente în fundal necesită în viitor un manager explicit, nu detașare implicită din terminal.

[Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) · [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)
