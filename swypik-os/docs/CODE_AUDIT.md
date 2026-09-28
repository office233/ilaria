# Audit de cod — 27 septembrie 2026

## Corecții

- **Server web:** paginile externe rulează într-un sandbox fără acces la originea aplicației; proxy-ul validează adresele la conectare, inclusiv la redirectare. Conectarea folosește IP-ul verificat. Răspunsurile au limită de dimensiune și păstrează statusul HTTP al sursei.
- **API local:** verificare Host/Origin, tratare OPTIONS, metode HTTP limitate și corp limitat pentru omnibar. Listarea directoarelor verifică limitele reale ale căilor și rezolvă symlinkurile. Au fost eliminate excepțiile pentru `D:\swypik-os` și `D:\ilaria`.
- **Fișiere publice:** numai HTML/CSS/JS ale interfeței sunt servite. Sursele Go, fișierele `.env` și starea swarm nu sunt expuse. Resursele sunt incluse în executabil.
- **Configurare:** inițializare sincronizată, prioritate pentru fișierele `.env` explicite, respectarea variabilelor de mediu deja definite, eliminarea configurărilor fără consumatori din structura globală. Portul, browserul și workspace-ul sunt utilizate efectiv. Launcherele folosesc propriul director.
- **Portofel:** fișierele corupte sunt păstrate; cheile și adresa sunt validate; NaN/Inf și valorile negative sunt respinse. Erorile de salvare sunt propagate. Salvarea folosește înlocuire prin fișier temporar.
- **L402:** decontarea repetată nu dublează soldurile; expirarea și caveatele sunt verificate; obiectele returnate nu permit modificarea facturii interne.
- **Audio:** bufferul funcționează și pentru dimensiuni care nu sunt puteri ale lui doi; scrierile concurente ale streamerului sunt serializate; chime-ul este livrat ca WAV și redat în browser.
- **GPU:** lipsa bibliotecilor/funțiilor este tratată fără apeluri nevalide; nu se mai inventează memorie, temperatură sau putere. Activarea SiLU are formula corectă. A fost eliminată blocarea recursivă a mutexului la citirea telemetriei.
- **Swarm:** oprirea așteaptă workerul înainte de salvare; testele își izolează starea; identificatorul și rata estimată a recompenselor folosesc configurația. Hashingul de fundal nu mai generează automat monede.
- **Agregare:** contribuțiile duplicate și rundele greșite sunt respinse. Gradientele și checkpointurile sunt copiate pentru a nu expune starea internă. Krum respinge intrările nule, dimensiunile incompatibile și valorile nefinite.
- **Foi:** formulele se recalculează după modificări, inclusiv dependențele; referințele cu mai multe litere sunt acceptate; ciclurile și intervalele invalide sunt raportate.
- **Interfață:** erorile HTTP/rețea/clipboard nu mai sunt prezentate drept succes; navigarea redeschide fereastra; URL-urile păstrează parametrii; pollingul nu suprapune cereri.

## Limite care rămân

Proiectul conține o aplicație Windows și mai multe module experimentale. Nu implementează încă toate promisiunile documentelor de arhitectură: un OS bootabil, inferență cu un model Ilaria real, antrenare GPU distribuită verificabilă, transport Azure complet, plăți reale, mail, stocare de proiecte și recunoaștere vocală.

Filtrarea comenzilor nu reprezintă un sandbox de sistem. Portofelul persistă cheile în clar. Proxy-ul izolat nu garantează compatibilitatea tuturor site-urilor. Aceste funcții necesită implementare și validare separată înainte de utilizare în producție.

Nu au fost șterse stările existente, documentele de arhitectură sau modulele experimentale doar pentru că nu sunt folosite de interfața web: unele sunt utilizate de interfața GDI și de bridge-ul mobil.

## Verificări reproductibile

```powershell
go test -timeout 60s ./...
go test -race -timeout 120s ./...
go vet ./...
node --check ui/web/desktop.js
node --test ui/web/desktop.test.cjs
go build -o swypik-os.exe ./cmd/swypik-os
go build -o SwypikInstaller.exe ./installer/windows
```

Testele de regresie sunt în fișierele `regression_test.go`, `internal/storage/file_test.go` și `ui/web/desktop.test.cjs`. Un rezultat verde verifică scenariile acoperite; nu certifică modulele simulate ca integrări reale.

## Rezultatul verificării

Au trecut suita Go, suita cu detectorul de concurență, `go vet`, verificarea sintaxei JavaScript și cele patru teste JavaScript. Au fost reconstruite `swypik-os.exe` și `SwypikInstaller.exe`.

Executabilul a trecut și o verificare headless dintr-un director temporar: pornire pe port dinamic, resurse incluse, configurare swarm, telemetrie, blocarea surselor și originilor nepermise, respingerea inputului gol, WAV valid și listarea workspace-ului izolat. Nu a fost efectuată o verificare vizuală completă a interfeței GDI sau a tuturor site-urilor externe.

Copia surselor dinaintea intervenției: `C:\Users\Pos5\AppData\Local\Temp\swypikos-before-cleanup-20260927-175719.zip`. Executabilele și directorul cu date nu sunt incluse în această copie.
