/**
 * Termeni și Condiții — sursă unică de adevăr.
 *
 * Reflectă modelul real de business (verificat în cod):
 *   - marketplace intermediar pentru produse, mâncare, transport
 *   - merchant of record pentru zboruri (Fly) și cazări prin API
 *   - comisioane reale: 10% Stays, 10% Fly (min 15 lei), etc.
 *   - plăți prin wallet intern + Stripe
 *
 * Cadru legal acoperit: OUG 34/2014 (drepturile consumatorilor), Legea
 * 365/2002 (comerț electronic), OG 21/1992 (protecția consumatorilor),
 * Reg. UE 524/2013 (SOL), Directiva 2019/2161 (transparența platformelor).
 *
 * ATENȚIE: la orice schimbare de comision sau politică, actualizează AICI.
 */

import { SUPPORT_EMAIL } from "@/lib/contact";

export const TERMS_LAST_UPDATED = "31 iulie 2026";

export type TermsSection = {
    id: string;
    title: string;
    body?: string[];
    bullets?: string[];
    table?: { headers: string[]; rows: string[][] };
};

export const TERMS_SECTIONS: TermsSection[] = [
    {
        id: "parti",
        title: "1. Cine suntem și ce accepți",
        body: [
            "Swypik este o platformă digitală integrată și marketplace multi-serviciu operat de Swypik Technology S.R.L. („Swypik”, „noi”), societate înregistrată în România. Prin crearea unui cont sau prin plasarea unei comenzi, accepți acești Termeni. Dacă nu ești de acord cu ei, te rugăm să nu folosești platforma.",
            "Acești Termeni se completează cu Politica de confidențialitate și cu Politica de cookie-uri.",
        ],
    },
    {
        id: "rol",
        title: "2. Rolul Swypik — intermediar sau vânzător",
        body: [
            "Rolul nostru diferă în funcție de ce cumperi, iar asta îți afectează drepturile. Îți spunem clar de fiecare dată:",
        ],
        table: {
            headers: ["Serviciu", "Rolul Swypik", "Cu cine ai contractul"],
            rows: [
                ["Shop, Food, Market", "intermediar", "vânzătorul/restaurantul"],
                ["Stays (gazde Swypik)", "intermediar + procesator plăți", "gazda"],
                ["Fly (bilete avion)", "vânzător (merchant of record)", "Swypik"],
                ["Go, Send, Move", "intermediar", "șoferul/curierul"],
                ["Swypik Cares", "facilitator tehnic și de donații (0% comision)", "cauza verificată"],
                ["Portofel Swypik", "furnizor de portofel intern și plăți", "Swypik"],
            ],
        },
        bullets: [
            "Ca intermediar, nu suntem parte în contractul de vânzare. Facilităm întâlnirea, plata și comunicarea, dar produsul/serviciul e furnizat de partener, care răspunde pentru conformitatea lui.",
            "Ca vânzător (Fly), noi suntem responsabili contractual față de tine pentru comanda respectivă.",
        ],
    },
    {
        id: "cont",
        title: "3. Contul tău",
        bullets: [
            "Trebuie să ai minimum 16 ani pentru a-ți crea un cont și 18 ani pentru a deveni partener (vânzător, gazdă, șofer, curier).",
            "Datele furnizate trebuie să fie reale și actuale. Conturile cu date false pot fi suspendate.",
            "Ești responsabil pentru păstrarea confidențialității parolei și pentru activitatea din contul tău.",
            "Îți poți șterge contul oricând din setări. Păstrăm doar datele pe care legea ne obligă să le reținem (ex. facturi).",
        ],
    },
    {
        id: "preturi",
        title: "4. Prețuri, comisioane și plăți",
        body: [
            "Prețul afișat este prețul final, cu TVA inclus. Nu adăugăm taxe la finalul comenzii — ce vezi, aia plătești.",
            "Comisioanele noastre sunt reținute din suma încasată de partener, nu adăugate peste prețul tău:",
        ],
        table: {
            headers: ["Serviciu", "Comision Swypik"],
            rows: [
                ["Stays (cazări)", "10% din valoarea rezervării"],
                ["Fly (zboruri)", "10% din tariful net, minimum 15 lei"],
                ["Food, Shop, Go", "conform contractului cu partenerul"],
                ["Swypik Cares (cauze caritabile)", "0% comision platformă (100% ajunge la cauză)"],
                ["Portofel Swypik (intern)", "0% comision pe transferuri între utilizatori"],
            ],
        },
        bullets: [
            "Plata se face prin card (procesat de Stripe) sau din portofelul Swypik.",
            "Datele cardului nu ajung pe serverele noastre.",
            "Pentru fiecare comandă primești document fiscal, conform legii.",
        ],
    },
    {
        id: "retragere",
        title: "5. Dreptul de retragere (14 zile)",
        body: [
            "Conform OUG 34/2014, ai dreptul să te retragi din contractele la distanță în 14 zile, fără să motivezi. Termenul curge de la primirea produsului.",
            "Legea prevede însă și excepții, care se aplică pe Swypik:",
        ],
        bullets: [
            "Mâncare, băuturi și produse perisabile — fără drept de retragere.",
            "Produse personalizate sau realizate la comandă — fără drept de retragere.",
            "Produse sigilate desigilate, din motive de igienă sau sănătate — fără drept de retragere.",
            "Servicii de cazare, transport și închirieri auto cu dată sau perioadă determinată — fără drept legal de retragere; se aplică politica de anulare afișată la rezervare.",
            "Bilete de avion — supuse condițiilor tarifare ale companiei aeriene, comunicate înainte de plată.",
        ],
    },
    {
        id: "anulari",
        title: "6. Anulări și rambursări",
        body: ["Politicile noastre de anulare sunt afișate înainte de a plăti, nu ascunse:"],
        bullets: [
            "Cazări: anulare gratuită cu cel puțin 5 zile înainte de check-in (rambursare 100%); sub 5 zile, rambursare 50%. Dacă gazda anulează, primești banii integral înapoi.",
            "Comenzi de mâncare: pot fi anulate până când restaurantul începe prepararea.",
            "Curse: anulabile până la acceptarea de către șofer, fără cost.",
            "Rambursările ajung în portofelul Swypik imediat, sau pe card în 5–10 zile lucrătoare.",
        ],
    },
    {
        id: "obligatii",
        title: "7. Ce nu este permis",
        bullets: [
            "Publicarea de anunțuri false, produse contrafăcute, ilegale sau periculoase.",
            "Ocolirea platformei pentru a evita comisionul, după ce contactul a fost făcut prin Swypik.",
            "Manipularea recenziilor, crearea de conturi multiple sau fraudarea promoțiilor.",
            "Hărțuirea altor utilizatori, discurs instigator la ură, conținut sexual explicit.",
            "Încercarea de a accesa neautorizat sistemele noastre.",
        ],
        body: [
            "Încălcarea acestor reguli poate duce la eliminarea conținutului, suspendarea sau închiderea contului, iar în cazuri grave la sesizarea autorităților.",
        ],
    },
    {
        id: "parteneri",
        title: "8. Reguli pentru parteneri",
        bullets: [
            "Trebuie să dețineți drepturile legale asupra a ceea ce vindeți sau închiriați și să prezentați documentele justificative la cerere.",
            "Gazdele trebuie să respecte legislația turistică (certificat de clasificare unde e cazul) și să fie înregistrate fiscal.",
            "Sunteți responsabili pentru propriile obligații fiscale. Raportăm veniturile către ANAF conform DAC7.",
            "Anulările repetate sau nerespectarea rezervărilor pot duce la suspendarea contului de partener.",
            "Plățile către parteneri se fac în portofelul Swypik, de unde pot fi retrase conform politicii de retrageri.",
        ],
    },
    {
        id: "continut",
        title: "9. Conținutul tău",
        body: [
            "Păstrezi drepturile asupra fotografiilor, videoclipurilor și textelor pe care le publici. Ne acorzi o licență neexclusivă, gratuită, pentru a le afișa și promova pe platformă și în materialele noastre de marketing, cât timp conținutul e publicat.",
            "Ești responsabil să ai dreptul de a publica acel conținut. Ștergem la sesizare orice material care încalcă drepturile altcuiva.",
        ],
    },
    {
        id: "raspundere",
        title: "10. Răspundere",
        body: [
            "Pentru comenzile în care suntem intermediari, răspunderea pentru produs sau serviciu revine partenerului. Noi răspundem pentru funcționarea platformei, procesarea corectă a plăților și pentru serviciile în care suntem vânzător.",
            "Nu răspundem pentru întreruperi cauzate de evenimente în afara controlului nostru (defecțiuni ale furnizorilor de internet, atacuri informatice, calamități).",
            "Nimic din acești Termeni nu limitează drepturile pe care legea ți le acordă ca și consumator.",
        ],
    },
    {
        id: "reclamatii",
        title: "11. Reclamații și rezolvarea disputelor",
        body: [
            `Scrie-ne întâi la ${SUPPORT_EMAIL} — răspundem în maximum 30 de zile. Majoritatea problemelor se rezolvă aici.`,
            "Dacă nu ești mulțumit, te poți adresa:",
        ],
        bullets: [
            "ANPC — Autoritatea Națională pentru Protecția Consumatorilor, www.anpc.ro",
            "SAL — soluționarea alternativă a litigiilor, prin ANPC.",
            "Platforma SOL a Comisiei Europene: ec.europa.eu/consumers/odr",
            "Instanțele judecătorești competente din România.",
        ],
    },
    {
        id: "modificari",
        title: "12. Modificări și lege aplicabilă",
        body: [
            "Putem actualiza acești Termeni. Pentru modificări importante te anunțăm cu cel puțin 15 zile înainte, prin email sau notificare în aplicație. Continuarea folosirii platformei după intrarea lor în vigoare înseamnă acceptare.",
            "Acestor Termeni li se aplică legea română. Comenzile deja plasate rămân guvernate de versiunea în vigoare la momentul comenzii.",
        ],
    },
];
