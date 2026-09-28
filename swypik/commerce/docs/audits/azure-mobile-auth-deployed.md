# Publicare autentificare mobilă — Azure, 27 septembrie 2026

Release: mobile-auth-20260927-175259, swypik-prod-web-1. Verificat public după activare.

Modificări: fallback Bearer pentru profilul guest fără combinarea identității seller/admin din cookie; rotație atomică a tokenurilor; respingerea conturilor banned/suspended/deleted și a suspendărilor temporare active.

Validare executată în Azure: 1924 teste, 202 fișiere; TypeScript; lint; i18n; build standalone. PostgreSQL Azure: refresh concurent, rollback la eșecul inserării și conturi restricționate, într-o schemă de fixture-uri eliminată după test. Canary: auth/me 401, refresh invalid 401, login invalid 400, ERP retras 410, seller products anonim 401 și feed 200. Verificarea publică /api/health confirmă tagul nou, DB/Redis/stocare OK. Email rămâne neconfigurat. Loginul complet cu un cont de test real și testarea pe telefoane rămân de efectuat.

Primul script de activare s-a oprit înainte de înlocuirea containerului deoarece compose.env nu există. A fost corectat să considere fișierul opțional; reactivarea a reușit. Release-ul anterior și imaginea sa sunt păstrate. Vezi PREVIOUS_TAG în directorul release-ului.

Sursa și validările mobile sunt în /opt/swypik/mobile/swypik-mobile-pilot. Studio nu este expus în prototip. Nu s-au importat proiectele ProxiTok/Clone-Wars și nu s-au schimbat domeniile, datele utilizatorilor, backendul Go sau infrastructura GPU.

Rapoarte pe server: azure-checks.log, azure-db-check.log, azure-build.log, azure-rollout.log. Instrucțiunile noi de lucru sunt în AZURE_WORKFLOW.md.
