# Shell-ul nativ (Capacitor) — semnalul `swypik-native`

Aplicațiile iOS/Android (Capacitor, `mobile/`) încarcă site-ul într-un WebView. Serverul și UI-ul
trebuie să știe că rulează în aplicație pentru regulile de plată ale magazinelor:

- **App Store 3.1.1** și **Google Play Payments policy**: conținutul digital deblocat în aplicație
  (episoade Movies, piese/albume Music) se vinde doar prin IAP-ul platformei. Până la integrarea
  IAP, build-urile native **ascund** cumpărarea deblocărilor digitale; conținutul deja deblocat
  (cumpărat pe web) rămâne redabil. Bunurile fizice și serviciile reale (shop, Stays, Food/Go)
  nu intră sub regulă.

## Contract (oricare e suficient)

| Semnal | Valoare | Unde se setează în shell |
|---|---|---|
| User-agent | conține `swypik-native` (ex. `swypik-native/1.0 (ios)`) | `capacitor.config.json` → `ios.appendUserAgent` / `android.appendUserAgent` |
| Antet HTTP | `x-swypik-native: 1` | interceptor pe cererile `fetch` ale shell-ului (opțional) |
| Cookie | `swypik_native=1` | setat de shell la pornire (pentru SSR) |

Cod: `lib/media/native-app.ts` (`isNativeAppRequest`, `isNativeAppClient`), hook-ul
`components/media/useIsNativeApp.ts`.

## Efect

- `POST /api/movies/[slug]/unlock`, `POST /api/music/tracks/[slug]/unlock`,
  `POST /api/music/albums/[slug]/unlock` → `403 { "error": "purchase_unavailable_in_app" }`.
- UI: butoanele de deblocare (Movies `UnlockButton`, Music `MusicPaywall`, pagina de album) sunt
  înlocuite cu mesajul `purchaseUnavailableInApp` (i18n, 7 limbi).

## De făcut în shell (owner / echipa mobile)

- Adăugarea `appendUserAgent: "swypik-native/<versiune> (<platformă>)"` în `mobile/capacitor.config.json`.
- Redarea audio în fundal (audit 2, P1): `UIBackgroundModes: audio` (iOS) și
  `FOREGROUND_SERVICE_MEDIA_PLAYBACK` + un plugin de media session (Android).
