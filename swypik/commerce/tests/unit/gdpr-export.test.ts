import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Gardian pentru exportul GDPR.
 *
 * Exportul e singura rută care, prin definiție, întoarce datele personale ale
 * unui utilizator într-un fișier. Dacă cineva adaugă acolo o coloană cu un
 * hash de parolă sau un token, transformă un drept legal într-o scurgere —
 * și nimic altceva din suită n-ar prinde asta.
 *
 * Testul citește sursa, nu rulează interogările: nu are nevoie de DB și
 * funcționează în CI.
 */
const SOURCE = readFileSync(
    join(process.cwd(), "lib/legal/data-export.ts"),
    "utf8",
);

/** Coloane care nu au voie să apară niciodată într-un export. */
const INTERZISE = [
    "password_hash",
    "session_token_hash",
    "token_hash",
    "cnp_encrypted",
    "cnp_hash",
    "entry_hash",
    "prev_hash",
    "oauth_client_secret_hash",
    "access_token",
    "refresh_token",
    "private_key",
    "api_token_hash",
    "key_hash",
    "fp_hash",
    "ip_hash",
];

    /** Doar conținutul interogărilor, fără comentarii — altfel un comentariu care
     *  menționează `SELECT *` produce un fals pozitiv (s-a întâmplat la scriere). */
    const QUERIES = (SOURCE.match(/sql:\s*`[^`]+`/g) ?? []).join("\n");

describe("exportul GDPR nu scurge secrete", () => {
    it.each(INTERZISE)("nu selectează %s", (col) => {
        // Căutăm coloana ca token SQL, nu ca substring dintr-un comentariu.
        const inSelect = new RegExp(`(SELECT|,)\\s*[a-z_.]*\\b${col}\\b`, "i");
            expect(QUERIES).not.toMatch(inSelect);
    });

    it("nu folosește SELECT * — o coloană nouă ar intra automat în export", () => {
            expect(QUERIES).not.toMatch(/SELECT\s+\*/i);
    });

    it("fiecare interogare filtrează pe utilizatorul din sesiune", () => {
        const selects = SOURCE.match(/sql:\s*`[^`]+`/g) ?? [];
        expect(selects.length).toBeGreaterThan(10);
        for (const s of selects) {
            // $1 e singurul parametru: id-ul vine din sesiune, nu din query string.
            expect(s).toMatch(/\$1/);
        }
    });

    it("nu expune tabelele de antifraudă (art. 15(4))", () => {
        // Publicarea semnalelor de risc ar ajuta exact pe cine le declanșează.
            expect(QUERIES).not.toMatch(/FROM\s+user_fraud_signals/i);
            expect(QUERIES).not.toMatch(/FROM\s+user_risk_scores/i);
            expect(QUERIES).not.toMatch(/FROM\s+user_fraud_decisions/i);
    });
});

describe("ruta de export nu acceptă identificare din exterior", () => {
    const ROUTE = readFileSync(
        join(process.cwd(), "app/api/account/export/route.ts"),
        "utf8",
    );

    it("nu citește userId din query string sau body", () => {
        // Un `?userId=` ar face din dreptul de acces cea mai comodă scurgere.
        expect(ROUTE).not.toMatch(/searchParams\.get\(\s*["']user/i);
        expect(ROUTE).not.toMatch(/body\.userId/);
    });

    it("cere autentificare și răspunde 401 fără ea", () => {
        expect(ROUTE).toMatch(/getAuthUser/);
        expect(ROUTE).toMatch(/401/);
    });

    it("are rate-limit", () => {
        expect(ROUTE).toMatch(/rateLimit\(/);
    });
});
