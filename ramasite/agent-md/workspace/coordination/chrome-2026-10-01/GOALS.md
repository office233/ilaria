# Nexus + Swypik — obiective de produs și criterii de rezultat

Actualizat: 1 octombrie 2026. Utilizatorul a reluat implementarea și a cerut
explicit preluarea aplicației Swypik pentru iOS și Android. Acest document
extinde scope-ul curent; nu declară finalizate obiectivele neîndeplinite.

## Ținta comună

Construim un ecosistem propriu, nativ, descentralizat și foarte eficient:
Ilaria IMC, Swyp Lang, SwypikOS și aplicația Swypik. Ținta de superioritate
față de AI/LLM și produse de referință se demonstrează prin evaluări independente,
reproductibile și actualizate: utilitate, corectitudine, siguranță, latență,
energie, cost și experiență de utilizare. Ambiția nu înlocuiește măsurătorile.

## Rezultate cerute

1. **Ilaria IMC proprie.** Model antrenat de la zero, cu runtime și memorie
   proprii, fără înlocuire cu altă familie/pretrained. Pilotul IMC-125M validează
   decizii înaintea țintei IMC-1B; finalizarea antrenării nu promovează modelul.
2. **Învățare P2P continuă.** Dispozitivele contribuie potrivit resurselor și
   consimțământului: semnale, actualizări candidate sau calcul. Experții pot sta
   pe calculatoare capabile. Protocoalele definesc autentificare, discovery,
   rutare, versiuni, indisponibilitate, backpressure și bugete.
3. **Îmbunătățire măsurată cu creșterea rețelei.** Mai mulți participanți utili
   și validați trebuie să îmbunătățească calitatea, acoperirea, capacitatea sau
   latența. Publicăm curbe de scalare și costuri; numărul brut de utilizatori
   nu dovedește că modelul devine mai inteligent.
4. **Promovare controlată și confidențialitate.** Proveniență, lineage, versiuni
   semnate, agregare robustă, evaluări înghețate, apărare poisoning/Sybil,
   protecție împotriva uitării și rollback verificat. Memoria personală rămâne
   locală implicit, iar datele private nu sunt colectate pentru training implicit.
   Sarcinile globale au emitent autorizat și leagă datele aprobate, scopul,
   rețeta, modelul părinte și bugetele. Semnătura și votul nu înlocuiesc evaluarea
   independentă; tokenizarea și criptarea transportului nu ascund datele de worker.
5. **Swyp Lang complet.** Semantică deterministă, parser/checker, Core IR,
   module, compilare, contracte, capabilități și erori clare. Limbajul funcționează
   independent de model; schema/protocol este granița dintre produse.
6. **SwypikOS funcțional și evolutiv.** Autoritate OS explicită, dispozitive,
   sandbox, UI și kernel nativ. Evoluția generează propuneri verificabile,
   teste izolate, comparații măsurate, promovare controlată și rollback;
   modelul nu primește autoritate OS ambientală.
7. **Consum minim demonstrat.** Profiluri CPU, RAM, stocare, rețea și energie;
   bugete configurabile, oprire la supraîncărcare și benchmarkuri înainte/după.
   Nu declarăm suport universal sau economie fără probe pentru platformele reale.
   Separăm dimensiunea ponderilor de RAM totală și memoria antrenării; raportăm
   energia ca nemăsurată când lipsesc contoare, fără deducții din CPU% sau TDP.
8. **Swypik iOS + Android.** Preluăm aplicația existentă din `E:\Swypik`,
   inclusiv `swypik-mobile-pilot`, păstrând arhitectura produsului. Livrăm aplicații
   instalabile, fluxuri principale utilizabile, API configurabil fără chei în
   aplicație, autentificare și stocare sigură, tratarea erorilor de rețea,
   accesibilitate, recuperare și performanță măsurată pe dispozitive suportate.
   Integrăm **Ilaria în aplicație** prin protocolul stabil al modelului, cu
   inferență locală pe dispozitive validate și cooperare explicită cu experții
   rețelei unde este necesar. Utilizatorii aplicației pot contribui la învățarea
   Ilaria fără instalarea obligatorie a SwypikOS; contribuția se adaptează
   capacității dispozitivului și suportului real iOS/Android.
   Participarea la calcul și folosirea datelor au acorduri distincte, revocabile.
   Sarcinile globale folosesc date aprobate și rețete semnate; conversațiile/datele
   personale rămân locale implicit. Propunerile nu devin ponderi globale înainte
   de evaluare independentă, verificarea versiunii părinte și promovare controlată.
   Definim pauză/oprire, bugete CPU/RAM/bytes, baterie/temperatură/încărcare,
   rețea permisă și reluare după întreruperi; nu presupunem training permanent
   în background sau full-model training pe orice telefon.
   Nu duplicăm SwypikOS, trainerul sau runtime-ul canonic Ilaria în aplicație.
9. **Dovezi de livrare mobilă.** Builduri reproductibile Android și iOS,
   verificarea pe emulator/simulator și dispozitive disponibile, matrice de
   suport și documentarea instalării/actualizării. Exportul JS/Hermes nu este
   APK/AAB/IPA și nu dovedește funcționarea pe telefon. Semnarea și distribuția
   externă se pregătesc pentru review; publicarea în magazine cere autorizare.
   Integrarea AI cere probe separate: cerere/răspuns real Ilaria, fallback și
   offline unde sunt implementate, contribuție autorizată de la aplicație,
   evaluare/adoptare/reject/rollback și revocare fără continuarea calculului.
   Măsurăm latența, memoria, bateria/energia cu instrumente reale și limitările
   de background pe platformele testate. UI-ul nu afișează training activ când
   backendul/native runtime-ul nu execută o sarcină verificată.
10. **Fluxuri cap-coadă și cod curat.** Gates pentru produse și protocoale,
    teste relevante, conformance, evaluări și benchmarkuri independente,
    operare documentată și raport final cu ce s-a schimbat și ce lipsește.

## Direcție multimodală evaluată, încă neimplementată

Encodere proprii și un conector către aceeași familie IMC pot extinde sistemul
la documente și audio. Alegem prima modalitate după capabilități și evaluarea
utilității, apoi comparăm precizia, memoria totală, latența, bytes și energia.
Ternarizarea conectorului, cache-ul și agregarea experților sunt experimente
distincte; niciunul nu garantează câștiguri sau aplicație completă de 300 MB.
Planul documentar și sursele primare sunt în
`ilaria-multimodal-efficiency-plan.md`; nu reprezintă un encoder funcțional.

## Reguli de execuție

- Criptomonedele și integrarea economică bazată pe ele sunt interzise explicit
  de utilizator. Din Bittensor/MAGNET studiem numai tehnologii transferabile;
  nu introducem TAO, HOOTi, walleturi, tokenuri tranzacționabile sau recompense
  în criptomonede. Semnăturile criptografice și hashurile de securitate rămân utile.
- Proprietari de fișiere exclusivi, branch/worktree dedicat, handoff verificat.
  Păstrăm munca existentă, checkout-ul principal, indexul și istoricul Git.
- Folosim agenți OpenCode și chaturi ChatGPT autorizate pentru implementare;
  root coordonează economic și verifică probe concise. Capacitatea Azure TPM
  se măsoară înainte de extinderea paralelismului.
- Plafon OpenCode: 500 USD/lună. Observăm costul local cu watcher live,
  stop operațional 400 USD/lună și 30 USD pentru primul batch; factura Azure
  și consumul altor clienți rămân evidențe distincte.
- Brev este autorizat explicit pentru o singură mașină cu 8×H200, maximum
  100 USD total din creditul existent. Limităm timpul plătit inclusiv setup/export,
  verificăm ștergerea instanței și salvarea artefactelor; fără credite suplimentare.
  Datele publice NOI se achiziționează în carantină conform comenzii utilizatorului;
  numai loturile calificate și înghețate intră în noua rețetă de antrenare.
- Păstrăm antrenarea Colab curentă; monitorizarea citește numai metadate/loguri.
  Fără training duplicat, secrete, corpusuri, weights ignorate sau date private.
- Fără reset/clean, push, deploy, publicare sau achiziții suplimentare.
  Rulăm testele afectate și `git diff --check` înaintea predării.

Registrul live, taskurile și probele sunt în `coordinator.md`; această listă
nu certifică rezultatele încă neobținute. Goalul afișat în chat a fost actualizat
prin API-ul oficial Codex `thread/goal/set` și verificat independent prin
`get_goal`: Swypik + Ilaria/contribuții incluse, status ACTIVE, fără paragraful
istoric PAUZATĂ. Acest fișier păstrează detaliile care nu încap în limita Goalului.
