/**
 * CINE ȚINE BANII — poarta unică dinaintea oricărei decontări.
 *
 * Audit 2026-09: `settleRide` și `settleLocalOrder` decideau ramura de decontare
 * exclusiv din `payment_method`, cu forma `const isCash = method === "cash"`.
 * Orice altceva cădea pe ramura „platforma are banii" și credita curierul/șoferul
 * din fondurile platformei — fără să verifice vreodată că plata chiar a reușit:
 *
 *   · `card_online` cu `payment_status='pending'` (clientul a închis modalul
 *     Stripe): comanda se livra, curierul era creditat, merchantul înregistrat
 *     ca datorie a platformei. Platforma nu încasase nimic.
 *   · `card_courier`: banii sunt fizic la curier (POS la ușă), dar era tratat
 *     ca plată online — curierul lua și numerarul, și creditul în wallet.
 *   · `wallet` la curse: acceptat de CHECK, neimplementat nicăieri, deci
 *     pasagerul nu era debitat niciodată, iar șoferul era creditat.
 *
 * Funcțiile de aici sunt pure și fail-closed: o metodă de plată necunoscută
 * întoarce "unpaid", nu "platform". Adăugarea unei metode noi în enum fără
 * implementarea încasării NU mai poate produce plăți din fondurile platformei.
 *
 * Valorile acceptate vin din CHECK-urile reale:
 *   local_orders.payment_method  ∈ cash | card_online | card_courier
 *   local_orders.payment_status  ∈ pending | paid | refunded | failed
 *   rides.payment_method         ∈ cash | card | wallet | card_online | card_courier
 *   rides.payment_status         ∈ unpaid | authorized | captured | collected_cash | failed | refunded
 */

/**
 * - `platform` — banii au intrat la platformă; ea datorează părțile.
 * - `courier`  — curierul/șoferul a încasat fizic; el datorează restul.
 * - `unpaid`   — nimeni nu a încasat. Nu se decontează; se raportează.
 */
export type FundCustody = "platform" | "courier" | "unpaid";

/** Metode la care banii ajung fizic la curier/șofer, nu la platformă. */
const LOCAL_ORDER_COURIER_COLLECTED = new Set(["cash", "card_courier"]);
const RIDE_COURIER_COLLECTED = new Set(["cash"]);

/**
 * Cine ține banii unei comenzi Eats livrate.
 *
 * `card_courier` e tratat ca numerar: POS-ul e al curierului, platforma nu vede
 * banii. `lib/payments/eats-stripe.ts` creează PaymentIntent doar pentru
 * `card_online`, deci orice altă metodă nu poate fi încasată online.
 */
export function localOrderCustody(
    paymentMethod: string | null | undefined,
    paymentStatus: string | null | undefined,
): FundCustody {
    // DEFAULT-ul coloanei e 'cash'; un rând vechi fără metodă e o comandă cash.
    const method = paymentMethod ?? "cash";

    if (LOCAL_ORDER_COURIER_COLLECTED.has(method)) return "courier";
    if (method === "card_online") return paymentStatus === "paid" ? "platform" : "unpaid";

    // Metodă necunoscută: niciodată nu presupunem că am încasat.
    return "unpaid";
}

/**
 * Cine ține banii unei curse finalizate.
 *
 * Doar `card` cu captura confirmată aduce banii la platformă. `authorized` NU e
 * suficient — autorizarea se poate pierde, iar captura efectivă scrie
 * `captured` (vezi `lib/payments/mobility-stripe.ts`). Captura sosită mai
 * târziu prin webhook reia decontarea, care e idempotentă pe (ref_type, ref_id).
 */
export function rideCustody(
    paymentMethod: string | null | undefined,
    paymentStatus: string | null | undefined,
): FundCustody {
    const method = paymentMethod ?? "cash";

    if (RIDE_COURIER_COLLECTED.has(method)) return "courier";
    if (method === "card") return paymentStatus === "captured" ? "platform" : "unpaid";

    // wallet / card_online / card_courier — permise de CHECK, dar fără
    // nicio cale de încasare implementată. Fail-closed.
    return "unpaid";
}
