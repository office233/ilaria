# Tehnologii alese după testarea OS-ului

27 septembrie 2026. Cercetare în documentația oficială. Nu există o tehnologie universal „cea mai bună”; alegem după defectele și cerințele măsurate. Ilaria/Ilaria rămâne singurul model.

| Tehnologie | Problema rezolvată | Decizie |
| --- | --- | --- |
| Playwright + Edge | Testarea reală a DOM-ului, formularelor, navigării, erorilor și stocării browserului | Folosit acum în scripts/e2e.cjs, în profil izolat |
| Go race detector + fuzzing | Concurență incorectă și intrări neprevăzute | Folosite în scripts/verify.ps1; fuzzing limitat la funcții fără efecte externe |
| Windows Job Objects | Procese copil care pot supraviețui anulării shellului | Implementat în core/coder/shell_windows.go; verificat cu procese copil reale |
| Microsoft WebView2 | Fereastră desktop cu lifecycle controlat de aplicație, în locul dependenței de procesul Edge lansat extern | Candidat pentru un prototip separat, înainte de migrare |
| Kernel/platform SwypikOS | OS independent, hardware authority, drivere, IPC, memorie, securitate | **OPEN ADR**. Linux-ul curent este reference/prototype, nu decizie de produs. Se compară Swypik-owned kernel/platform, hybrid compatibility și Linux reference prin benchmark |
| Swyp Compute Fabric | Utilizatorii pot contribui voluntar GPU/CPU/NPU idle pentru Ilaria și workload-uri verificate | **Strategic requirement**. Opt-in, revocabil, signed jobs, leases, sandbox, resource governor, result verification; zero crypto/mining |

Playwright oferă așteptare automată pentru acțiuni și aserțiuni care reîncearcă până când starea așteptată este vizibilă. Harnessul curent folosește locatoare și așteptări pe starea paginii. [Aserțiuni](https://playwright.dev/docs/test-assertions), [auto-waiting](https://playwright.dev/docs/actionability).

Go are fuzzing nativ ghidat de acoperire. Detectorul de concurență și fuzzingul caută clase diferite de defecte; niciunul nu demonstrează absența tuturor erorilor. [Go fuzzing](https://go.dev/doc/security/fuzz/), [practici de securitate Go](https://go.dev/doc/security/best-practices).

Windows Job Objects permit gestionarea grupurilor de procese și terminarea proceselor asociate. OS creează shellul suspendat, îl asociază jobului și apoi îl pornește; închiderea jobului oprește procesele asociate. Testele verifică anulare, copil rămas după încheierea părintelui și execuție concurentă. Acest mecanism nu limitează permisiunile utilizatorului și nu izolează operații delegate altor servicii Windows. [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

WebView2 folosește un model cu mai multe procese. Nu îl prezentăm drept soluție automată pentru consumul de memorie. Prototipul trebuie să măsoare pornirea, memoria, închiderea ferestrei, recuperarea după crash și izolarea conținutului. [Modelul proceselor](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model), [evenimentele proceselor](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-related-events).

Nu introducem un framework nou pentru a bifa o listă. Păstrăm Go și UI-ul
existent până când un prototip demonstrează un avantaj. Ținta este ca SwypikOS
să depășească Windows/macOS/Linux pe workload-urile sale țintă, dar orice astfel
de afirmație trebuie susținută de benchmarkuri comparabile și reproductibile.
