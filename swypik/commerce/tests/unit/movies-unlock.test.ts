import { describe, it, expect, vi, beforeEach } from "vitest";

let insertConflictStatus: string | null = null;
let createdIntent: { id: string; client_secret: string | null } = { id: "pi_1", client_secret: "secret_1" };
let stripeCreateCalls: Array<Record<string, unknown>> = [];
let creditCalls: Array<Record<string, unknown>> = [];
let debitCalls: Array<Record<string, unknown>> = [];
let revokeMatches = true;
let claimed = new Set<string>();
let outcomes: Array<[unknown, unknown]> = [];
let refundCalls: Array<Record<string, unknown>> = [];
let grantMatches = true;
let currentRow: { status: string; payment_intent_id: string | null } | null = null;
let seasonPaid = false;
let creditFails = false;
let episodeSeriesId = "s1";
const insertSql: string[] = [];

const series = { id: "s1", owner_user_id: "owner-1", status: "published", free_episodes: 3, episode_price_cents: "500" };

vi.mock("@/lib/db", () => ({ dbQuery: vi.fn(query), withTransaction: async (fn: (q: unknown) => Promise<unknown>) => fn(query) }));
vi.mock("@/lib/stripe/checkout", () => ({
  getStripe: () => ({
    paymentIntents: {
      create: vi.fn(async (params: Record<string, unknown>) => {
        stripeCreateCalls.push(params);
        return createdIntent;
      }),
    },
    refunds: {
      create: vi.fn(async (params: Record<string, unknown>, opts: Record<string, unknown>) => {
        refundCalls.push({ ...params, ...opts });
        return { id: "re_1" };
      }),
    },
  }),
}));
vi.mock("@/lib/wallet/ledger", () => ({
  creditUser: vi.fn(async (args: Record<string, unknown>) => {
    creditCalls.push(args);
    return { entry: { id: "ledger-1" }, alreadyApplied: false };
  }),
  creditUserTx: vi.fn(async (_q: unknown, args: Record<string, unknown>) => {
    if (creditFails) throw new Error("ledger down");
    creditCalls.push(args);
    return { entry: { id: "ledger-1" }, alreadyApplied: false };
  }),
  debitUser: vi.fn(async (args: Record<string, unknown>) => {
    debitCalls.push(args);
    return { entry: { id: "ledger-2" }, alreadyApplied: false };
  }),
}));

async function query(sql: string, params: unknown[] = []) {
  if (sql.startsWith("INSERT INTO media_unlock_payments")) {
    const pi = String(params[0]);
    if (claimed.has(pi)) return { rows: [], rowCount: 0 };
    claimed.add(pi);
    return { rows: [{ payment_intent_id: pi }], rowCount: 1 };
  }
  if (sql.startsWith("UPDATE media_unlock_payments")) { outcomes.push([params[0], params[1]]); return { rows: [], rowCount: 1 }; }
  if (sql.startsWith("SELECT status, payment_intent_id FROM movie_unlocks")) return { rows: currentRow ? [currentRow] : [], rowCount: currentRow ? 1 : 0 };
  if (sql.startsWith("SELECT 1 FROM movie_unlocks WHERE user_id")) return { rows: seasonPaid ? [{ "?column?": 1 }] : [], rowCount: seasonPaid ? 1 : 0 };
  if (sql.startsWith("UPDATE movie_unlocks SET amount_cents")) return { rows: [], rowCount: 1 };
  if (sql.startsWith("INSERT INTO movie_unlocks")) insertSql.push(sql);
  if (sql.includes("UPDATE movie_unlocks u") && sql.includes("SET status = 'paid'") && !grantMatches) return { rows: [], rowCount: 0 };
  if (sql.includes("FROM movie_episodes e") && sql.includes("JOIN movie_series")) {
    // Filtrul `e.series_id = $2` al interogării reale.
    if (params[1] !== episodeSeriesId) return { rows: [], rowCount: 0 };
    return { rows: [{ ...series, series_id: "s1", episode_number: 5 }], rowCount: 1 };
  }
  if (sql.startsWith("SELECT id, owner_user_id, status, license_expires_at")) {
    return { rows: [series], rowCount: 1 };
  }
  if (sql.includes("COUNT(*)") && sql.includes("movie_episodes")) return { rows: [{ count: "40" }], rowCount: 1 };
  if (sql.startsWith("INSERT INTO movie_unlocks")) {
    return { rows: [{ id: "unlock-1", status: insertConflictStatus ?? "pending" }], rowCount: 1 };
  }
  if (sql.includes("UPDATE movie_unlocks u") && sql.includes("SET status = 'paid'")) {
    if (params[0] !== "pi_1" && params[1] !== "unlock-1") return { rows: [], rowCount: 0 };
    return {
      rows: [{ id: "unlock-1", user_id: "viewer-1", series_id: "s1", episode_id: "ep-5", amount_cents: "500", owner_user_id: "owner-1" }],
      rowCount: 1,
    };
  }
  if (sql.startsWith("UPDATE movie_unlocks SET payment_intent_id")) return { rows: [], rowCount: 1 };
  if (sql.includes("UPDATE movie_unlocks u") && sql.includes("SET status = 'refunded'")) {
    if (!revokeMatches || params[0] !== "pi_1") return { rows: [], rowCount: 0 };
    return { rows: [{ id: "unlock-1", owner_id: "owner-1", share: "350" }], rowCount: 1 };
  }
  if (sql.startsWith("SELECT 1 FROM movie_unlocks")) return { rows: [], rowCount: 0 };
  if (sql.startsWith("UPDATE movie_unlocks SET units_paid")) return { rows: [], rowCount: 1 };
  throw new Error("unexpected sql: " + sql.slice(0, 80));
}

import { createEpisodeUnlockIntent, createSeasonUnlockIntent, markMovieUnlockPaid, revokeMovieUnlockForPayment, unlockRefId } from "@/lib/movies/unlock";

beforeEach(() => {
  insertConflictStatus = null;
  createdIntent = { id: "pi_1", client_secret: "secret_1" };
  stripeCreateCalls = [];
  creditCalls = [];
  debitCalls = [];
  revokeMatches = true;
  claimed = new Set();
  outcomes = [];
  refundCalls = [];
  grantMatches = true;
  currentRow = null;
  seasonPaid = false;
  creditFails = false;
  episodeSeriesId = "s1";
  (series as { license_expires_at?: string | null }).license_expires_at = null;
  insertSql.length = 0;
});

describe("movies/unlock — card (Stripe, RON)", () => {
  it("refId-ul este determinist per user+țintă", () => {
    expect(unlockRefId("u1", { episodeId: "e1" })).toBe("movie_unlock:u1:episode:e1");
    expect(unlockRefId("u1", { seriesId: "s1" })).toBe("movie_unlock:u1:season:s1");
  });

  it("creează un PaymentIntent Stripe cu suma și metadata corecte", async () => {
    const r = await createEpisodeUnlockIntent({ userId: "viewer-1", episodeId: "ep-5", seriesId: "s1" });
    expect(r).toEqual({ ok: true, alreadyUnlocked: false, clientSecret: "secret_1", amountCents: 500 });
    expect(stripeCreateCalls).toHaveLength(1);
    expect(stripeCreateCalls[0]).toMatchObject({
      amount: 500,
      currency: "ron",
      metadata: { kind: "movie_unlock", seriesId: "s1", episodeId: "ep-5", userId: "viewer-1" },
      payment_method_types: ["card"],
    });
    expect(stripeCreateCalls[0]).not.toHaveProperty("automatic_payment_methods");
  });

  it("licență expirată → nu se poate cumpăra (nici episod, nici sezon)", async () => {
    (series as { license_expires_at?: string | null }).license_expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await createEpisodeUnlockIntent({ userId: "viewer-1", episodeId: "ep-5", seriesId: "s1" })).toEqual({ ok: false, reason: "series_not_published" });
    expect(await createSeasonUnlockIntent({ userId: "viewer-1", seriesId: "s1" })).toEqual({ ok: false, reason: "series_not_published" });
    expect(stripeCreateCalls).toHaveLength(0);
  });

  it("episodul trebuie să aparțină titlului din URL", async () => {
    episodeSeriesId = "other-series";
    expect(await createEpisodeUnlockIntent({ userId: "viewer-1", episodeId: "ep-5", seriesId: "s1" })).toEqual({ ok: false, reason: "not_found" });
    expect(stripeCreateCalls).toHaveLength(0);
  });

  it("creditarea cotei eșuează → eroare (retry Stripe), rezultatul NU e marcat granted", async () => {
    creditFails = true;
    await expect(markMovieUnlockPaid({ paymentIntentId: "pi_1", unlockId: "unlock-1", amountReceivedCents: 500, currency: "ron" })).rejects.toThrow("ledger down");
    expect(outcomes).toEqual([]);
    // Retry-ul (outcome încă `processing`) reia și creditează.
    creditFails = false;
    claimed.clear();
    await markMovieUnlockPaid({ paymentIntentId: "pi_1", unlockId: "unlock-1", amountReceivedCents: 500, currency: "ron" });
    expect(creditCalls).toHaveLength(1);
    expect(outcomes).toEqual([["pi_1", "granted"]]);
  });

  it("deblocare deja plătită → alreadyUnlocked, fără PaymentIntent nou", async () => {
    insertConflictStatus = "paid";
    const r = await createEpisodeUnlockIntent({ userId: "viewer-1", episodeId: "ep-5", seriesId: "s1" });
    expect(r).toEqual({ ok: true, alreadyUnlocked: true });
    expect(stripeCreateCalls).toHaveLength(0);
  });

  it("sezonul: 37 episoade blocate × 500 − 40% = 11100 cenți", async () => {
    const r = await createSeasonUnlockIntent({ userId: "viewer-1", seriesId: "s1" });
    expect(r).toEqual({ ok: true, alreadyUnlocked: false, clientSecret: "secret_1", amountCents: 11100 });
  });

  it("preț nesetat (null) → price_not_set", async () => {
    (series as { episode_price_cents: string | null }).episode_price_cents = null;
    const r = await createEpisodeUnlockIntent({ userId: "viewer-1", episodeId: "ep-5", seriesId: "s1" });
    expect(r).toEqual({ ok: false, reason: "price_not_set" });
    (series as { episode_price_cents: string | null }).episode_price_cents = "500";
  });

  it("webhook payment_intent.succeeded: marchează plătit + creditează cota creatorului (70%)", async () => {
    await markMovieUnlockPaid({ paymentIntentId: "pi_1", unlockId: "unlock-1", amountReceivedCents: 500, currency: "ron" });
    expect(creditCalls).toHaveLength(1);
    expect(creditCalls[0]).toMatchObject({ userId: "owner-1", amountCents: 350, refType: "movie_creator_share", refId: "unlock-1" });
  });

  it("webhook idempotent: payment_intent necunoscut/deja plătit → no-op", async () => {
    await markMovieUnlockPaid({ paymentIntentId: "pi_unknown", unlockId: null, amountReceivedCents: 500, currency: "ron" });
    expect(creditCalls).toHaveLength(0);
  });
  it("folosește suma încasată efectiv de Stripe pentru cotă (nu prețul salvat)", async () => {
    await markMovieUnlockPaid({ paymentIntentId: "pi_1", unlockId: "unlock-1", amountReceivedCents: 1000, currency: "ron" });
    expect(creditCalls[0]).toMatchObject({ amountCents: 700, refType: "movie_creator_share" });
  });

  it("găsește deblocarea după unlockId din metadata chiar dacă intentul a fost înlocuit", async () => {
    await markMovieUnlockPaid({ paymentIntentId: "pi_old", unlockId: "unlock-1", amountReceivedCents: 500, currency: "ron" });
    expect(creditCalls).toHaveLength(1);
  });

  it("monedă neașteptată sau sumă 0 → acces neacordat, fără cotă", async () => {
    await markMovieUnlockPaid({ paymentIntentId: "pi_1", unlockId: "unlock-1", amountReceivedCents: 500, currency: "eur" });
    await markMovieUnlockPaid({ paymentIntentId: "pi_1", unlockId: "unlock-1", amountReceivedCents: 0, currency: "ron" });
    expect(creditCalls).toHaveLength(0);
  });

  it("refund total / dispută pierdută: revocă accesul și retrage cota (sold poate deveni negativ)", async () => {
    await expect(revokeMovieUnlockForPayment("pi_1", "refund")).resolves.toBe(true);
    expect(debitCalls).toHaveLength(1);
    expect(debitCalls[0]).toMatchObject({ userId: "owner-1", amountCents: 350, refType: "movie_creator_share_reversal", refId: "unlock-1", allowNegative: true });
  });

  it("revocare pentru o plată care nu e deblocare → false, nimic debitat", async () => {
    revokeMatches = false;
    await expect(revokeMovieUnlockForPayment("pi_other", "refund")).resolves.toBe(false);
    expect(debitCalls).toHaveLength(0);
  });
});

describe("movies/unlock — idempotență și cursa plății duble", () => {
  it("retry Stripe pentru același PaymentIntent → procesat o singură dată (o singură cotă)", async () => {
    await markMovieUnlockPaid({ paymentIntentId: "pi_1", unlockId: "unlock-1", amountReceivedCents: 500, currency: "ron" });
    await markMovieUnlockPaid({ paymentIntentId: "pi_1", unlockId: "unlock-1", amountReceivedCents: 500, currency: "ron" });
    expect(creditCalls).toHaveLength(1);
    expect(outcomes).toEqual([["pi_1", "granted"]]);
  });

  it("a doua plată pentru o deblocare deja plătită cu alt intent → rambursare automată, fără cotă", async () => {
    grantMatches = false;
    currentRow = { status: "paid", payment_intent_id: "pi_1" };
    await markMovieUnlockPaid({ paymentIntentId: "pi_2", unlockId: "unlock-1", amountReceivedCents: 500, currency: "ron" });
    expect(creditCalls).toHaveLength(0);
    expect(refundCalls).toHaveLength(1);
    expect(refundCalls[0]).toMatchObject({ payment_intent: "pi_2", reason: "duplicate", idempotencyKey: "unlock_duplicate_refund:pi_2" });
    expect(outcomes).toEqual([["pi_2", "duplicate_refunded"]]);
  });

  it("livrare concurentă a aceluiași intent (rândul e deja plătit cu el) → fără rambursare", async () => {
    grantMatches = false;
    currentRow = { status: "paid", payment_intent_id: "pi_1" };
    await markMovieUnlockPaid({ paymentIntentId: "pi_1", unlockId: "unlock-1", amountReceivedCents: 500, currency: "ron" });
    expect(refundCalls).toHaveLength(0);
    expect(outcomes).toEqual([["pi_1", "granted"]]);
  });

  it("intent fără deblocare cunoscută → unknown_unlock, fără acces și fără rambursare", async () => {
    grantMatches = false;
    await markMovieUnlockPaid({ paymentIntentId: "pi_x", unlockId: null, amountReceivedCents: 500, currency: "ron" });
    expect(refundCalls).toHaveLength(0);
    expect(creditCalls).toHaveLength(0);
    expect(outcomes).toEqual([["pi_x", "unknown_unlock"]]);
  });

  it("upsert-ul pending nu suprascrie suma unui rând deja plătit", async () => {
    await createEpisodeUnlockIntent({ userId: "viewer-1", episodeId: "ep-5", seriesId: "s1" });
    expect(insertSql[0]).toMatch(/CASE WHEN movie_unlocks.status = 'paid' THEN movie_unlocks.amount_cents/);
  });

  it("sezonul deja plătit acoperă episodul → alreadyUnlocked, fără PaymentIntent", async () => {
    seasonPaid = true;
    expect(await createEpisodeUnlockIntent({ userId: "viewer-1", episodeId: "ep-5", seriesId: "s1" })).toEqual({ ok: true, alreadyUnlocked: true });
    expect(stripeCreateCalls).toHaveLength(0);
  });
});
