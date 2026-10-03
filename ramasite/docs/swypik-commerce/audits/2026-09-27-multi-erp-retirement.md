# Multi-ERP retirement — 2026-09-27

Owner confirmed: retain native Swypik /seller; retire separate Multi-ERP.

Local ERP backend/PostgreSQL and Azure ERP PostgreSQL stopped with restart=no. Final dumps are in E:\Swypik\audit-multierp-20260927\backups. Database volumes retained offline. Azure ERP ingress on both web nodes returns HTTP 410. Native /seller responds HTTP 200 after normal login redirect. Swypik health remains successful; its daily offsite backup succeeds without ERP.

Source, Git history and uncommitted work archived at E:\Swypik\archive\multi-erp-retired-20260927. Original directory retains an empty hidden .git directory: automatic approval review blocked its deletion. WSL /opt/multi-erp is retained offline. Branding cleanup was interrupted by retirement and the archive is not release ready.

Infra source disables the ERP DB profile by default, refuses --multi-erp and removes automatic ERP activation. Azure data compose updated in place; web-1 ERP env renamed with .retired-20260927 suffix. Source changes not pushed. Generic external ERP connector code and historical records in Swypik remain; native merchant pages were not changed.

Recovery copies of cloudflared configuration and backup wrapper have .before-erp-retirement suffixes. Restore only on explicit request. WSL still requires a separate dependency audit before deletion.


## Actualizare finală — panoul nativ, publicat pe ambele noduri Azure

Release verificat: `28687e3971d1-native-seller-599f18682f02`.
Sursa exactă și manifestul SHA-256 sunt în `E:\Swypik\audit-multierp-20260927\native-seller-release.tar.gz` și `release-manifest.json`. Imaginea Linux a fost construită o singură dată, apoi distribuită identic. Platform API folosește același binar Go anterior, fără modificări.

- Integrarea externă ERP este dezactivată prin `FEATURE_EXTERNAL_ERP=0`: dispare din meniu și onboarding; asistentul dependent de ERP nu mai este afișat. API-urile connect/status/sync și proxy-ul Selena returnează 410 fără apeluri către ERP. DELETE pentru deconectare rămâne autentificat și disponibil. Codul generic de integrare și istoricul bazei nu au fost șterse.
- Produsele, comenzile, facturile, clienții și POS-ul Swypik sunt păstrate. Accesul public fără sesiune duce la login, iar API-urile native răspund 401 fără sesiune, conform regulilor existente. Nu am emis facturi, trimis emailuri sau efectuat plăți reale.
- Serviciile Multi-ERP au fost eliminate din fișierele Compose active ale noului release și din configurația nodului data. Preflight nu mai cere parola bazei ERP retrase.
- Validare: 1.920 teste Vitest în 203 fișiere; 10 teste Python de infrastructură; TypeScript; lint fără erori (cu avertismente); build Windows și imagine Linux reușite.
- Înainte de schimbarea traficului, fiecare nod a trecut verificările într-un container temporar: health cu versiunea exactă, ERP=410, produse native=401. Nodurile au fost actualizate succesiv; containerele temporare au fost eliminate.
- După actualizare: ambele containere healthy, ambele tuneluri active; health public healthy, database=ok, redis=ok, storage=true. `erp.swypik.com` și `/api/seller/erp/connect` răspund 410. `/seller/erp` fără sesiune trece mai întâi prin redirecționarea de autentificare; pagina ERP este dezactivată în aplicație.

Configurația web activă pe fiecare nod: `/opt/swypik/releases/28687e3971d1-native-seller-599f18682f02/infra/azure/compose/web.yml`. Versiunea anterioară pentru revenire: `28687e3971d18e97d6fdb4e2d2c0bf7f0e4a9f23`, păstrată ca imagine și în `PREVIOUS_TAG`. Starea release-ului este salvată în `/opt/swypik/state/web.tag` pe ambele noduri. Nu au fost executate migrări DB. Modificările locale nu au fost împinse în Git remote; un deploy viitor trebuie să folosească sursa actualizată, nu checkout-ul vechi de pe VM.

Blocajele separate de lansare din audit rămân: configurarea reală email/Stripe, apeluri, conținut și demonstrarea capacității prin teste de încărcare. Retragerea ERP nu validează aceste fluxuri și nu reduce automat prețul VM-urilor deja alocate.
