import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localOrderCustody, rideCustody } from "@/lib/payments/fund-custody";

/**
 * Regresie pentru pierderile confirmate în auditul 2026-09.
 *
 * Fiecare `it` de mai jos corespunde unui scenariu care, înainte de poartă,
 * credita curierul/șoferul din fondurile platformei fără ca platforma să fi
 * încasat vreun leu. Toate au fost reproduse pe cod real de verificatori
 * adversariali înainte de a fi reparate.
 */

describe("localOrderCustody — comenzi Eats", () => {
    it("cash: curierul a încasat la ușă", () => {
        expect(localOrderCustody("cash", "pending")).toBe("courier");
        expect(localOrderCustody("cash", "paid")).toBe("courier");
    });

    it("card_courier: POS-ul e al curierului — banii NU sunt la platformă", () => {
        // Bug-ul: era tratat ca plată online, deci curierul lua și numerarul de
        // la ușă, și creditul în wallet, iar platforma mai datora și merchantul.
        expect(localOrderCustody("card_courier", "pending")).toBe("courier");
        expect(localOrderCustody("card_courier", "paid")).toBe("courier");
    });

    it("card_online confirmat: abia acum platforma are banii", () => {
        expect(localOrderCustody("card_online", "paid")).toBe("platform");
    });

    it("card_online NEconfirmat: nimeni nu a încasat", () => {
        // Scenariul exact: clientul închide modalul Stripe, comanda intră în
        // dispatch, curierul livrează, PATCH status='delivered' → decontare.
        expect(localOrderCustody("card_online", "pending")).toBe("unpaid");
        expect(localOrderCustody("card_online", "failed")).toBe("unpaid");
        expect(localOrderCustody("card_online", null)).toBe("unpaid");
    });

    it("card_online rambursat: banii au plecat înapoi", () => {
        expect(localOrderCustody("card_online", "refunded")).toBe("unpaid");
    });

    it("rând vechi fără metodă = cash (DEFAULT-ul coloanei)", () => {
        expect(localOrderCustody(null, "pending")).toBe("courier");
        expect(localOrderCustody(undefined, null)).toBe("courier");
    });

    it("FAIL-CLOSED: o metodă nouă neimplementată nu produce plăți", () => {
        expect(localOrderCustody("bnpl", "paid")).toBe("unpaid");
        expect(localOrderCustody("crypto", "paid")).toBe("unpaid");
    });
});

describe("rideCustody — curse Go", () => {
    it("cash: șoferul a încasat", () => {
        expect(rideCustody("cash", "collected_cash")).toBe("courier");
        expect(rideCustody("cash", "unpaid")).toBe("courier");
    });

    it("card capturat: platforma are banii", () => {
        expect(rideCustody("card", "captured")).toBe("platform");
    });

    it("card doar AUTORIZAT nu e încasare", () => {
        // Autorizarea se poate pierde; doar captura mută banii.
        expect(rideCustody("card", "authorized")).toBe("unpaid");
    });

    it("card fără PaymentIntent: nimeni nu apelează vreodată authorize", () => {
        // payment_intent_id rămâne NULL → captureRidePayment iese cu null →
        // înainte, settleRide credita oricum șoferul.
        expect(rideCustody("card", "unpaid")).toBe("unpaid");
        expect(rideCustody("card", "failed")).toBe("unpaid");
        expect(rideCustody("card", null)).toBe("unpaid");
    });

    it("wallet: acceptat de CHECK, nicăieri implementat — pasagerul nu e debitat", () => {
        expect(rideCustody("wallet", "captured")).toBe("unpaid");
        expect(rideCustody("wallet", "unpaid")).toBe("unpaid");
    });

    it("card_online / card_courier: permise de CHECK, fără cale de încasare", () => {
        expect(rideCustody("card_online", "captured")).toBe("unpaid");
        expect(rideCustody("card_courier", "captured")).toBe("unpaid");
    });

    it("rând vechi fără metodă = cash", () => {
        expect(rideCustody(null, "unpaid")).toBe("courier");
    });

    it("FAIL-CLOSED: metodă necunoscută", () => {
        expect(rideCustody("apple_pay", "captured")).toBe("unpaid");
    });
});

describe("poarta e efectiv cablată în decontare", () => {
    // Testele de mai sus verifică funcția pură. Asta verifică faptul că
    // `settleRide` / `settleLocalOrder` chiar o folosesc — altfel poarta ar
    // putea fi corectă și complet ocolită, exact ca înainte de audit.
    const mobility = readFileSync(join(__dirname, "..", "..", "lib", "payments", "mobility.ts"), "utf8");

    it("importă și apelează ambele porți", () => {
        expect(mobility).toContain('from "@/lib/payments/fund-custody"');
        expect(mobility).toMatch(/const custody = localOrderCustody\(/);
        expect(mobility).toMatch(/const custody = rideCustody\(/);
    });

    it("NU mai derivă ramura direct din payment_method", () => {
        // Forma care a produs pierderea: `const isCash = (x.payment_method ?? "cash") === "cash"`
        expect(mobility).not.toMatch(/payment_method\s*\?\?\s*"cash"\)\s*===\s*"cash"/);
    });

    it("ambele interogări aduc payment_status — fără el poarta e oarbă", () => {
        expect(mobility).toMatch(/lo\.payment_method,\s*lo\.payment_status/);
        expect(mobility).toMatch(/r\.payment_method,\s*r\.payment_status/);
    });

    it("refuzul de decontare iese înainte de comision și settled_at", () => {
        const rideBody = mobility.slice(mobility.indexOf("export async function settleRide"));
        const gate = rideBody.indexOf('custody === "unpaid"');
        expect(gate).toBeGreaterThan(-1);
        for (const after of ["recordCommission(", "SET settled_at"]) {
            expect(rideBody.indexOf(after), `${after} trebuie să vină DUPĂ poartă`).toBeGreaterThan(gate);
        }
    });
});

describe("invariantul care oprește pierderea", () => {
    it("NICIO combinație în afara celor două încasări reale nu dă 'platform'", () => {
        const localMethods = ["cash", "card_online", "card_courier", "bnpl", null];
        const localStatuses = ["pending", "paid", "refunded", "failed", null];

        for (const m of localMethods) {
            for (const s of localStatuses) {
                const custody = localOrderCustody(m, s);
                if (custody === "platform") {
                    expect({ m, s }).toEqual({ m: "card_online", s: "paid" });
                }
            }
        }

        const rideMethods = ["cash", "card", "wallet", "swyp", "card_online", "card_courier", null];
        const rideStatuses = ["unpaid", "authorized", "captured", "collected_cash", "failed", "refunded", null];

        for (const m of rideMethods) {
            for (const s of rideStatuses) {
                const custody = rideCustody(m, s);
                if (custody === "platform") {
                    expect({ m, s }).toEqual({ m: "card", s: "captured" });
                }
            }
        }
    });
});
