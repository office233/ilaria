# Testare funcțională — 27 septembrie 2026

## Rezultat verificat

| Verificare | Rezultat |
| --- | --- |
| Go cu race detector și coverage | 111 cazuri/subcazuri trecute; 1 test live Ilaria skipped |
| go vet | Trecut |
| JavaScript | 4 teste trecute |
| Edge headless, executabil real | 11 scenarii trecute; zero excepții JavaScript capturate |
| Fuzzing URL, 15 secunde | 292.773 execuții, fără eșec |
| Fuzzing output comenzi, 15 secunde | 100.396 execuții, fără eșec |
| Build OS și installer | Trecut |
| Acoperire Go | 64,0% din instrucțiunile instrumentate |

Runda de verificare a fost întreruptă de reluarea conversației după testele Go. Pașii rămași — vet, JavaScript, fuzzing, build și Edge — au fost executați separat și au trecut. Nu prezentăm scriptul întrerupt ca rulare continuă încheiată.

## Defecte reproduse înainte de fix

1. Preview pentru `notes.txt` relativ la workspace întorcea 404, fiind rezolvat după directorul procesului. Acum folosește aceeași rădăcină ca listarea fișierelor.
2. Omnibar accepta al doilea document JSON sau text suplimentar după obiectul inițial. Acum validează sfârșitul întregului corp înainte de execuție.
3. Shutdown revenea după două secunde, lăsând inferența activă. Acum închide conexiunile rămase când expiră perioada de închidere grațioasă, anulând contextul cererilor.

Testele de regresie au eșuat înainte de fix și au trecut după modificări.

## Artefacte locale

Folder: `C:\Users\Pos5\AppData\Local\Temp\swypik-verification-3c8d72ed88f74bd69c7a8b153184625c`.

- `go-tests.jsonl`: evenimentele și rezultatele Go.
- `coverage.out`: datele de acoperire.
- `browser/results.json`: scenariile UI și duratele.
- `browser/desktop.png`: captură UI.
- `browser/server.log`: logul executabilului din test.

Reproducere: vezi TESTING.md și scripts/verify.ps1.

## Ce nu este demonstrat

Ilaria reală nu răspundea pe portul 8091; scenariile Edge folosesc o fixture explicită pentru succes/eroare/istoric. Nu am testat training GPU, servicii de producție autentificate, actualizări/rollback, oprirea întregului arbore de procese sau UI GDI. Acoperirea include și prototipuri; nu este procent de funcționalitate finalizată. Rezultatele nu justifică afirmația că aplicația este lipsită de orice bug.
