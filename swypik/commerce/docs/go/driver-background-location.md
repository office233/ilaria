# Șoferi / curieri — localizare și heartbeat în fundal (Capacitor)

Audit food-go #10 (2026-09-28). Pe mobil, heartbeat-ul și GPS-ul rulau pe un timer
JS: când șoferul deschidea Maps/Waze, WebView-ul intra în fundal, heartbeat-ul se
oprea, după 120 s sweep-ul îl scotea offline, iar istoricul GPS avea goluri (tariful
final cădea pe estimare).

## Ce e implementat (server + web)

- **Grație pe job activ:** `sweepStaleCouriers` nu mai scoate offline un curier/șofer
  cu job `assigned` cât ultimul heartbeat e mai nou de
  `DISPATCH_ACTIVE_JOB_STALE_SECONDS` (implicit 900 s). Fără job rămâne pragul
  `DISPATCH_COURIER_STALE_SECONDS` (120 s) — ofertele merg doar la șoferi „vii".
- **Punte nativă:** `components/go/driver/native-location.ts` folosește pluginul
  `@capacitor-community/background-geolocation` dacă aplicația nativă îl expune
  (`window.Capacitor.Plugins.BackgroundGeolocation`). Fiecare fix trimite poziția +
  heartbeat-ul (`POST /api/couriers/status`, cu viteză și direcție), limitat la
  `NEXT_PUBLIC_DRIVER_HEARTBEAT_MS`. În browser/PWA rămâne `watchPosition`.
- **Alerte:** `components/go/alert-audio.ts` deblochează sunetul la primul gest (iOS).

## Ce trebuie făcut în proiectele native (`mobile/`)

1. `npm i @capacitor-community/background-geolocation` în proiectul Capacitor al
   aplicației de șofer, apoi `npx cap sync`.
2. **Android** (`AndroidManifest.xml`): `ACCESS_FINE_LOCATION`,
   `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`,
   `POST_NOTIFICATIONS`; serviciul pluginului rulează ca foreground service cu
   notificarea „Swypik Go — ești online" (textele vin din `goDriver.bgLocation`).
   Play Console: declarația de „background location" (video + justificare: șoferul
   primește curse și e urmărit doar cât e online sau are o cursă activă).
3. **iOS** (`Info.plist`): `UIBackgroundModes` → `location`;
   `NSLocationWhenInUseUsageDescription` și
   `NSLocationAlwaysAndWhenInUseUsageDescription` (texte localizate).
4. **Oferte cu aplicația închisă:** push nativ (FCM/APNs) prin
   `@capacitor/push-notifications`, înregistrat în `user_push_tokens` (grupul
   auth-email deține notificările) — `sendPushToUser` trimite deja „Cursă nouă" /
   „Livrare nouă" (`mobilityPush`), cu `tag` per job.
5. Testare: pornește online, deschide Waze 10 min cu o cursă activă → șoferul rămâne
   online, `courier_location_history` are puncte continue, tariful final e pe GPS.
