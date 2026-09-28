/**
 * Conținutul politicii de confidențialitate — sursă unică de adevăr.
 *
 * IMPORTANT: reflectă ce colectează EFECTIV platforma (verificat în cod și DB).
 * La orice funcționalitate nouă care prelucrează date personale, actualizează
 * și acest fișier — altfel politica devine falsă, ceea ce e o încălcare GDPR
 * în sine (principiul transparenței, art. 5(1)(a)).
 *
 * Ultima verificare față de cod: 20 august 2026.
 *
 * AUDIT 2026-08-20 — ce s-a corectat și de ce:
 *   Secțiunea „Drepturile tale" promitea șapte drepturi „exercitabile gratuit"
 *   fără să existe niciun mecanism: zero rute de export, zero buton de ștergere.
 *   Mai grav, tabelul de retenție promitea „ștergere definitivă în 30 de zile",
 *   dar `users` are 101 constrângeri copil, dintre care 5 (swyp_ledger_entries,
 *   messages, flight_bookings, product_safety_labels) blochează un DELETE.
 *   Ștergerea completă nu era doar neimplementată — era imposibilă structural.
 *
 *   O politică ce promite ce nu poți livra e ea însăși o încălcare (art. 5(1)(a),
 *   transparență). Acum textul descrie ce se întâmplă efectiv: export automat,
 *   restul pe email, cu excepțiile din art. 17(3) explicate pe nume.
 */

export const PRIVACY_LAST_UPDATED = "20 august 2026";

export type PrivacySection = {
    id: string;
    title: string;
    /** Paragrafe de text. */
    body?: string[];
    /** Tabel opțional: [antet, ...rânduri]. */
    table?: { headers: string[]; rows: string[][] };
    /** Listă cu buline. */
    bullets?: string[];
};

export const PRIVACY_SECTIONS: PrivacySection[] = [
    {
        id: "operator",
        title: "1. Cine suntem",
        body: [
            "Swypik este operat de Swypik Technology, societate înregistrată în România. Suntem „operator de date” în sensul Regulamentului (UE) 2016/679 (GDPR) pentru datele descrise mai jos.",
            "Pentru orice întrebare privind datele tale personale, scrie-ne la privacy@swypik.com. Îți răspundem în cel mult 30 de zile.",
        ],
    },
    {
        id: "date",
        title: "2. Ce date colectăm și de ce",
        body: [
            "Colectăm doar datele necesare pentru funcționarea serviciului. Mai jos, exact ce se strânge, pentru ce și pe ce temei legal:",
        ],
        table: {
            headers: ["Date", "Scop", "Temei legal"],
            rows: [
                ["Email, nume, telefon", "cont, comunicări despre comenzi", "executarea contractului"],
                ["Parolă (hash)", "autentificare securizată", "executarea contractului"],
                ["Adresă de livrare", "livrarea comenzilor", "executarea contractului"],
                ["Adresă IP, user-agent", "securitate, prevenirea fraudei", "interes legitim"],
                ["Locație GPS (curieri/șoferi)", "atribuirea și urmărirea curselor", "executarea contractului"],
                ["Istoric comenzi și plăți", "facturare, suport, garanții", "obligație legală"],
                ["CNP (gazde, persoane fizice)", "raportare fiscală ANAF (DAC7)", "obligație legală"],
                ["CUI/CIF (firme)", "facturare și raportare", "obligație legală"],
                ["Documente de verificare", "verificarea identității partenerilor", "obligație legală"],
                ["Comportament în aplicație", "recomandări, îmbunătățirea produsului", "consimțământ"],
            ],
        },
    },
    {
        id: "sensibile",
        title: "3. Date sensibile — cum le protejăm",
        body: [
            "Anumite date necesită protecție suplimentară, iar noi aplicăm măsuri tehnice specifice:",
        ],
        bullets: [
            "CNP-ul gazdelor este criptat AES-256-GCM în baza de date. Nu este stocat niciodată în clar, nu apare public și, în panoul de administrare, se afișează doar mascat (ex: 1••••••••7890). Îl decriptăm exclusiv pentru raportarea fiscală obligatorie sau la solicitarea autorităților.",
            "Parolele sunt stocate ca hash criptografic — nici noi nu le putem citi.",
            "Datele cardurilor bancare nu ajung niciodată pe serverele noastre: plățile sunt procesate de Stripe, furnizor certificat PCI-DSS.",
            "Adresa IP și user-agent-ul sunt anonimizate automat: după 90 de zile pentru sesiuni, notificări și analiza de conținut, respectiv 180 de zile pentru jurnalele de plăți și semnalele antifraudă, unde termenul mai lung e necesar investigării unei fraude semnalate târziu.",
        ],
    },
    {
        id: "cookies",
        title: "4. Cookie-uri",
        body: [
            "Folosim cookie-uri strict necesare (autentificare, coș, securitate) fără de care platforma nu funcționează — acestea nu necesită acordul tău.",
            "Cookie-urile de analiză și marketing se activează doar dacă le accepți explicit în banner. Îți poți schimba opțiunea oricând din setările de confidențialitate, fără să pierzi accesul la serviciu.",
        ],
    },
    {
        id: "terti",
        title: "5. Cui transmitem datele",
        body: [
            "Nu vindem datele tale. Le transmitem doar cui este strict necesar pentru livrarea serviciului:",
        ],
        table: {
            headers: ["Destinatar", "Ce primește", "De ce"],
            rows: [
                ["Stripe", "date de plată, email", "procesarea plăților"],
                ["Vânzători / gazde / curieri", "nume, telefon, adresă", "livrarea comenzii sau a cazării"],
                ["Duffel", "nume pasager, dată naștere", "emiterea biletelor de avion"],
                ["Furnizor de email (Resend)", "email, conținutul notificării", "trimiterea confirmărilor"],
                ["ANAF", "date fiscale, venituri", "obligație legală (DAC7)"],
                ["Hetzner (Germania)", "găzduirea serverelor", "infrastructură"],
            ],
        },
    },
    {
        id: "transfer",
        title: "6. Unde sunt stocate datele",
        body: [
            "Serverele noastre sunt în Uniunea Europeană (Germania). Unii furnizori (ex. Stripe) pot procesa date în afara UE, dar doar pe baza clauzelor contractuale standard aprobate de Comisia Europeană sau a unei decizii de adecvare.",
        ],
    },
    {
        id: "retentie",
        title: "7. Cât timp păstrăm datele",
        table: {
            headers: ["Tip de date", "Perioadă"],
            rows: [
                ["Cont activ", "cât timp ai contul deschis"],
                ["După ștergerea contului", "30 de zile, apoi ștergere sau anonimizare (vezi 8.2)"],
                ["Facturi și documente fiscale", "10 ani (obligație legală)"],
                ["CNP și date de raportare DAC7", "conform termenului fiscal aplicabil"],
                ["Adresă IP, user-agent", "90 de zile, apoi anonimizare"],
                ["Adresă IP în jurnale de plăți și antifraudă", "180 de zile, apoi anonimizare"],
                ["Sesiuni expirate", "30 de zile"],
            ],
        },
    },
    {
        id: "drepturi",
        title: "8. Drepturile tale",
        body: [
            "Conform GDPR, ai următoarele drepturi, pe care le poți exercita gratuit:",
        ],
        bullets: [
            "Acces și portabilitate — descarci singur, imediat, un fișier JSON cu datele tale, din Contul meu → Confidențialitate. Dacă preferi alt format sau ai nevoie de ceva ce nu apare acolo, scrie-ne la privacy@swypik.com.",
            "Rectificare — îți corectezi singur datele de profil, adresele și preferințele din contul tău. Pentru date pe care nu le poți edita (ex. cele dintr-o factură deja emisă), scrie-ne.",
            "Ștergere — ne scrii la privacy@swypik.com. Îți ștergem sau anonimizăm datele, cu excepțiile explicate mai jos, care sunt prevăzute de GDPR art. 17(3).",
            "Restricționare — să ceri limitarea prelucrării cât timp verificăm o contestație. Cerere pe email.",
            "Opoziție — să te opui prelucrărilor bazate pe interes legitim (securitate, prevenirea fraudei). Cerere pe email.",
            "Retragerea consimțământului — oricând, singur, din bannerul de cookie-uri sau din setările de confidențialitate. Nu afectează accesul la serviciu.",
        ],
    },
    {
        id: "cum-exerciti",
        title: "8.1. Cum trimiți o cerere și ce se întâmplă cu ea",
        body: [
            "Trimite cererea la privacy@swypik.com de pe adresa de email cu care ți-ai făcut contul. Dacă scrii de pe altă adresă, îți vom cere să confirmi identitatea — nu ca să îngreunăm procesul, ci pentru că a preda datele cuiva care se dă drept tine ar fi tot o încălcare.",
            "Scrie clar ce drept vrei să exerciți. Îți confirmăm primirea și îți răspundem în cel mult 30 de zile, termenul legal. Dacă cererea e complexă, te anunțăm din timp — GDPR permite o prelungire de încă două luni, dar numai cu motivare.",
            "Cererile se procesează manual, de o persoană. Nu există un buton automat pentru ștergere, iar asta e o alegere deliberată: o cerere de ștergere e ireversibilă și merită verificată.",
        ],
    },
    {
        id: "limite-stergere",
        title: "8.2. Ce NU putem șterge și de ce",
        body: [
            "Vrem să fim exacți aici, pentru că majoritatea politicilor sunt vagi tocmai în acest punct. Când ceri ștergerea contului, unele date rămân:",
        ],
        bullets: [
            "Facturile și documentele fiscale — 10 ani, obligație legală (Codul fiscal, Legea contabilității 82/1991). GDPR art. 17(3)(b) prevede explicit această excepție.",
            "Datele necesare apărării unui drept în justiție sau soluționării unei dispute în curs — pe durata acesteia (art. 17(3)(e)).",
        ],
    },
    {
        id: "ce-inseamna-stergere",
        title: "8.3. Ce înseamnă concret „ștergere”",
        body: [
            "Pentru datele care nu intră în excepțiile de mai sus, ștergem rândurile. Pentru cele care trebuie păstrate, aplicăm anonimizarea: înlocuim numele, emailul și telefonul cu valori care nu duc la tine, astfel încât înregistrarea contabilă rămâne validă, dar nu mai e o dată cu caracter personal.",
            "Contul devine inaccesibil imediat ce procesăm cererea. Ștergerea propriu-zisă se finalizează în cel mult 30 de zile.",
        ],
    },
    {
        id: "contact",
        title: "9. Contact și reclamații",
        body: [
            "Pentru exercitarea drepturilor sau orice nelămurire: privacy@swypik.com.",
            "Dacă nu ești mulțumit de răspunsul nostru, te poți adresa Autorității Naționale de Supraveghere a Prelucrării Datelor cu Caracter Personal (ANSPDCP), Bd. G-ral. Gheorghe Magheru 28-30, București, www.dataprotection.ro.",
        ],
    },
    {
        id: "minori",
        title: "10. Minori",
        body: [
            "Swypik nu se adresează persoanelor sub 16 ani. Pentru a deveni gazdă, vânzător, șofer sau curier trebuie să ai minimum 18 ani — verificăm acest lucru inclusiv prin CNP. Dacă aflăm că am colectat date de la un minor sub 16 ani fără acordul părintelui, le ștergem.",
        ],
    },
    {
        id: "modificari",
        title: "11. Modificări",
        body: [
            "Când modificăm această politică, actualizăm data de mai sus. Pentru schimbări importante, te anunțăm prin email sau printr-o notificare în aplicație, cu cel puțin 15 zile înainte de intrarea lor în vigoare.",
        ],
    },
];
