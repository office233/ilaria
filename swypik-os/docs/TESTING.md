# Verificare reproductibilă

## Comandă completă pe Windows

```powershell
powershell -NoProfile -File scripts/verify.ps1 -E2E -FuzzSeconds 15
```

Necesită Go, compilator C pentru race detector, Node, Edge și Playwright disponibil pentru Node. Playwright poate proveni din runtime-ul local al uneltei de dezvoltare prin NODE_PATH; nu este dependență a aplicației livrate. Scriptul nu instalează pachete și nu descarcă browsere.

Fără browser: omite `-E2E`. Fără sesiunea de fuzzing: omite `-FuzzSeconds`; corpusurile seed rulează în continuare în testele Go.

Rapoartele sunt în folderul temporar indicat la final: JSONL Go, coverage și, cu E2E, results.json, screenshot și logul serverului. Sursele nu sunt încărcate cu rezultate generate.

## Ce testează Edge

Executabil real SwypikOS, port dinamic, profil de browser separat și workspace temporar: catalog, căutare, detalii, pin persistent, fișiere text/binare/prea mari, navigare în directoare, comandă Windows reală și inofensivă, comandă blocată, conversație și eroare Ilaria, istoric, afișare inertă a textului, tastatură și excepții JavaScript.

Serviciul Ilaria folosit de E2E este o fixture explicită, nu modelul real. Nicio conversație de test nu demonstrează inferență GPU. Serviciile externe de producție și lansarea aplicațiilor autentificate nu sunt testate de acest script.

## Test separat cu model real

După ce agentul Ilaria pornește serviciul cu un checkpoint declarat:

```powershell
$env:SWYPIK_ILARIA_TEST_URL = 'http://127.0.0.1:8091'
go test ./core/ilaria -run TestLiveIlariaBackend -v -count=1
Remove-Item Env:SWYPIK_ILARIA_TEST_URL
```

Acest test verifică răspunsul și folosirea istoricului. Fără variabila explicită, testul este marcat skipped, nu trecut ca inferență reală.

## Limite

Acoperirea de cod este un indicator al codului executat de teste, nu al calității produsului sau al funcțiilor implementate. Prototipurile de training nu devin antrenare reală prin faptul că testele lor trec. Sunt necesare separat teste pe hardware GPU, update/rollback, procese copil și UI nativ GDI.
