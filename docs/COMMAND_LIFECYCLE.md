# Procesele terminalului — implementare și verificare

27 septembrie 2026. Executorul Windows folosește acum Windows Job Objects.

## Comportament

1. Creează un job anonim, cu terminarea proceselor la închiderea ultimului handle.
2. Creează cmd.exe suspendat, fără fereastră de consolă. AutoRun este dezactivat prin /d.
3. Limitează handle-urile moștenite la stdin și outputul comenzii.
4. Asociază shellul jobului înainte de prima instrucțiune, apoi îl reia.
5. Capturează outputul în limita existentă de 256 KiB.
6. La anulare sau la încheierea shellului închide jobul și așteaptă terminarea procesului și citirea outputului.

Dacă asocierea cu jobul eșuează, comanda nu este executată. Codul de ieșire nenul produce eroare. Timeoutul rămâne 30 secunde; contextul HTTP poate anula comanda mai devreme.

## Verificări reale

- Anularea shellului oprește procesul copil de test.
- Un părinte care se încheie normal nu lasă copilul să ruleze în fundal.
- Opt comenzi concurente au output separat.
- Un handle de eveniment moștenibil din procesul de test nu ajunge la comandă.
- Ghilimelele, directoarele cu spații și codul de ieșire 7 sunt tratate corect.
- Verificări executate pe Windows amd64 cu race detector și pe Windows 386 fără race detector.

Testele creează doar procese și fișiere proprii; nu opresc procese identificate doar după nume. Implementarea nu adaugă un serviciu sau un executabil helper în produs.

## Limite explicite

Runda completă după integrare: **118 cazuri Go trecute, 4 teste JavaScript și 11 scenarii Edge trecute**, go vet și build reușite. Un test live Ilaria rămâne skipped. Acoperire Go: 64,3%. Artefacte: `C:\Users\Pos5\AppData\Local\Temp\swypik-verification-d46a802a10124dadb397ac86770d4a72`.

Acesta este management de lifecycle, nu sandbox de securitate. Comanda păstrează permisiunile utilizatorului. Servicii externe cărora o comandă le cere să pornească alte procese nu devin automat membri ai jobului. Sarcinile persistente în fundal necesită în viitor un manager explicit, nu detașare implicită din terminal.

[Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) · [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)
