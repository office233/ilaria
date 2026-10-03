# SwypikOS · Swypik · Ilaria

Implementare desktop: 27 septembrie 2026. UI-ul folosește direcția vizuală aprobată: alabastru, sticlă, violet Swypik și o singură bară Ilaria jos, cu săgeata în dreapta.

## Ce este conectat

- **SwypikOS**: catalog de aplicații, favorite locale, Files cu navigare și previzualizare text, browser și terminal local.
- **Swypik din E:**: 30 de intrări preluate din registrul `lib/nav/modules.ts` și navigarea principală. Include Go, Food, Stays, Fly, Movies, Music, Gaming, News, Messenger, Live, Shop și modulele business/account. Sunt puncte de acces ale platformei, nu 30 de executabile rescrise.
- **Ilaria / Ilaria**: bara de jos utilizează `/api/omnibar`, care apelează backendul local Ilaria existent. Comenzile `open movies`, `open go`, `open studio`, `open ilaria` și `open files` sunt rezolvate explicit de desktop. Textul generat de model nu execută automat acțiuni.
- **Studio**: serviciul local din `E:/Swypik Studio`, distinct de consumul de filme `/movies` și de proiectul Cinema Studio din `E:/Swypik movies`.

`Start-SwypikOS.bat` pornește acum gazda Electron din `desktop/`. Aplicațiile sunt `WebContentsView` în zona centrală a aceleiași ferestre. Taburile păstrează paginile deschise, iar navigarea, Files și chatul rămân accesibile. Sunt aplicațiile web existente găzduite în componente desktop native, nu rescrieri Win32. Nu folosim iframe și nu eliminăm CSP/X-Frame-Options.

Gazda pornește propriul serviciu Go pe un port loopback disponibil și îl oprește la închidere. Profilul persistent al aplicațiilor Swypik este comun și separat de shell. Sesiunea browserului existent nu este copiată: este necesară autentificarea în noul profil. Unele servicii SSO pot refuza browsere integrate. Numai shellul primește IPC; aplicațiile externe nu primesc preload sau Node. Locația, media și notificările cer acord pentru sesiune. Endpointul vechi `/api/apps/launch` întoarce 409 pentru ID-uri cunoscute în loc să lanseze ferestre separate.

## Gazda desktop și conectorii

Dependențele și runtime-ul Electron sunt instalate pe această mașină. Pe alt dispozitiv: construiește Go, apoi în `desktop` rulează `npm ci` și `npm run setup`. Este necesar Node >=22.12. Launcherul este `Start-SwypikOS.bat`; alternativa de dezvoltare este `npm start --prefix desktop`. Executabilul Go pornit direct păstrează modul browser existent. Previzualizarea web nu are bridge nativ și explică acest lucru în UI.

Catalogul include 18 servicii și Custom MCP. GitHub, Linear și Figma au endpointuri oficiale precompletate. Celelalte carduri cer un endpoint MCP; nu sunt adaptoare proprii Gmail/Drive/Slack. Nu este o copie completă a conectorilor ChatGPT/Codex și nu importă autorizările lor.

Clientul folosește SDK-ul oficial MCP și transport Streamable HTTP. Sunt implementate OAuth cu PKCE, callback loopback validat prin state, bearer token, handshake, descoperirea paginată a instrumentelor, afișarea schemelor și apelarea cu confirmare nativă. Rezultatul poate fi copiat în bara Ilaria pentru trimitere explicită; Ilaria nu rulează automat instrumentele.

Datele de autentificare sunt criptate în `connectors.vault` prin Electron safeStorage/Windows DPAPI, fără expunere în lista din renderer. La restart conexiunile salvate cer reconectare. Ștergerea locală nu revocă accesul la furnizor. Nu sunt implementate stdio, SSE legacy sau autentificări proprietare. Furnizorii care cer aprobarea clientului pot refuza SwypikOS.

Referințe: [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [SDK MCP](https://github.com/modelcontextprotocol/typescript-sdk), [GitHub MCP](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md), [Linear MCP](https://linear.app/docs/mcp), [Figma MCP](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/).

## Configurație locală

`desktop-integrations.json` conține numai adrese de servicii și căi locale, fără parole:

- `platform_url`: implicit `https://swypik.com`; poate fi o instanță locală/staging. Override: `SWYPIK_PLATFORM_URL`.
- `studio_url`: `http://127.0.0.1:4848`, conform `src/studio.ts` din Studio.
- `ilaria_url`: adresa dashboardului Ilaria. Este separată de endpointul de inferență configurat prin `-ilaria-url`.
- `workspaces`: directoarele permise suplimentar în Files. Root-ul SwypikOS și directorul Home rămân disponibile.

Override pentru locația fișierului: `SWYPIK_DESKTOP_CONFIG`. Căile acestei mașini sunt configurare explicită, nu constante în sursa serverului. Directoarele inexistente nu apar în listă. Pentru modificări de configurare, folosește Refresh în desktop.

Files respectă limitele proiectelor inclusiv pentru symlink-uri. Previzualizările text sunt limitate la 256 KB, returnate ca JSON și afișate ca text; HTML nu se execută. Accesul la API rămâne local și protejat prin verificarea Host/Origin/metodei.

## Actualizarea catalogului

```powershell
python scripts/sync-swypik-apps.py E:/Swypik/swypik/app
powershell -File scripts/build.ps1
```

Catalogul este inclus în executabil. Feature flags și rolurile sunt păstrate ca metadate; desktopul nu activează module dezactivate și nu acordă roluri. Swypik decide disponibilitatea la deschiderea aplicației. Catalogul include și intrări ascunse implicit în meniul web pentru a inventaria ecosistemul cerut de utilizator; ele nu sunt declarate operaționale.

Serviciile locale trebuie pornite separat. La verificare, Ilaria `/health` a răspuns `ready`, iar conversația din UI a primit `Hello!` la `Salut, Ilaria!`. Studio pe 4848 nu era pornit. Endpointul de dashboard 8080 a răspuns 401, deci necesită autentificare/verificarea configurației. Nu am modificat proiectele E: sau Ilaria, nici configurația de producție Swypik.

## Verificări

- Test al gazdei cu Electron simulat: reutilizarea views, sesiuni comune, izolare IPC și bounds.
- Test MCP cu server HTTP local: initialize, tools/list paginat, tools/call, persistență, deconectare și ascunderea tokenului.
- Test OAuth pentru callback fără state respins și callback corect acceptat.
- Panoul de conectori verificat în previzualizarea web. Verificarea automată de aprobare a respins lansarea Electron; fereastra nativă și autentificările reale nu sunt încă verificate end-to-end.

- Teste pentru catalog pe aceeași origine, lansări limitate la ID-uri cunoscute, blocarea cererilor cross-origin și a metodei greșite.
- Teste pentru previzualizări text inerte, dimensiune maximă, fișiere binare și limite de directoare.
- Testele JavaScript existente pentru erori, navigare și clipboard.
- Verificare în UI: navigare `ui/web`, previzualizare `apps.json`, proiectul Swypik din E:, Terminal `go version`, răspuns Ilaria real, cerere de lansare Go acceptată.

Nu sunt implementate aici sincronizare offline a datelor platformei, un nou sistem SSO între origini diferite, rescrierea modulelor în UI nativ sau distribuirea automată a serviciilor Ilaria/Studio. Integrarea folosește serviciile și sesiunile existente.
