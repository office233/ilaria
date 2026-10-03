import { describe, expect, it } from "vitest";
import { parseLikedIds as parseIds } from "@/lib/feed/liked-ids";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("GET /api/feed/offers/liked — validarea parametrului ids", () => {
    it("acceptă o listă normală de UUID-uri", () => {
        const r = parseIds(`${A},${B}`);
        expect(r).toEqual({ ok: true, ids: [A, B] });
    });

    it("tratează lipsa parametrului ca listă goală, nu ca eroare", () => {
        // Pagina e publică; un 400 aici ar polua consola degeaba.
        expect(parseIds(null)).toEqual({ ok: true, ids: [] });
        expect(parseIds("")).toEqual({ ok: true, ids: [] });
    });

    it("ignoră spațiile și intrările goale din listă", () => {
        expect(parseIds(` ${A} , , ${B} ,`)).toEqual({ ok: true, ids: [A, B] });
    });

    it("deduplică — altfel un client repetitiv umflă query-ul degeaba", () => {
        expect(parseIds(`${A},${A},${A}`)).toEqual({ ok: true, ids: [A] });
    });

    it("respinge orice nu e UUID (protejează ANY($2::uuid[]) de o eroare de tip)", () => {
        expect(parseIds("nu-e-uuid").ok).toBe(false);
        expect(parseIds(`${A},nu-e-uuid`)).toEqual({ ok: false, error: "invalid_id" });
        // tentativă de injecție: trebuie oprită la validare, nu la baza de date
        expect(parseIds("'; DROP TABLE likes; --").ok).toBe(false);
    });

    it("respinge peste 50 de id-uri", () => {
        const many = Array.from({ length: 51 }, (_, i) =>
            `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
        ).join(",");
        expect(parseIds(many)).toEqual({ ok: false, error: "too_many_ids" });
    });

    it("acceptă exact 50 — pragul nu e off-by-one", () => {
        const fifty = Array.from({ length: 50 }, (_, i) =>
            `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
        ).join(",");
        const r = parseIds(fifty);
        expect(r.ok).toBe(true);
        expect(r.ok && r.ids).toHaveLength(50);
    });

    it("deduplică ÎNAINTE de a verifica pragul", () => {
        // 60 de intrări, dar un singur id distinct: nu e abuz, e un client redundant.
        const r = parseIds(Array.from({ length: 60 }, () => A).join(","));
        expect(r).toEqual({ ok: true, ids: [A] });
    });
});
