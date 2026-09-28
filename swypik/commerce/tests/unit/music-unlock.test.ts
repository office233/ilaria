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
const insertSql: string[] = [];

const premiumTrack = { id: "t2", artist_user_id: "artist-1", status: "published", is_premium: true, price_cents: "300" };
const freeTrack = { id: "t1", artist_user_id: "artist-1", status: "published", is_premium: false, price_cents: null };
let currentTrack: Record<string, unknown> = premiumTrack;

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
  if (sql.startsWith("SELECT status, payment_intent_id FROM music_unlocks")) return { rows: currentRow ? [currentRow] : [], rowCount: currentRow ? 1 : 0 };
  if (sql.startsWith("SELECT 1 FROM music_unlocks WHERE user_id")) return { rows: seasonPaid ? [{ "?column?": 1 }] : [], rowCount: seasonPaid ? 1 : 0 };
  if (sql.startsWith("UPDATE music_unlocks SET amount_cents")) return { rows: [], rowCount: 1 };
  if (sql.startsWith("INSERT INTO music_unlocks")) insertSql.push(sql);
  if (sql.includes("UPDATE music_unlocks u") && sql.includes("SET status = 'paid'") && !grantMatches) return { rows: [], rowCount: 0 };
  if (sql.includes("FROM music_tracks t WHERE t.id = $1")) return { rows: [currentTrack], rowCount: 1 };
  if (sql.includes("FROM music_albums al WHERE al.id = $1")) {
    return { rows: [{ id: "al1", artist_user_id: "artist-1", status: "published", price_cents: null }], rowCount: 1 };
  }
  if (sql.includes("FROM music_tracks WHERE album_id")) {
    return { rows: [{ is_premium: true, price_cents: "300" }, { is_premium: true, price_cents: "300" }, { is_premium: false, price_cents: null }], rowCount: 3 };
  }
  if (sql.startsWith("INSERT INTO music_unlocks")) {
    return { rows: [{ id: "unlock-1", status: insertConflictStatus ?? "pending" }], rowCount: 1 };
  }
  if (sql.includes("UPDATE music_unlocks u") && sql.includes("SET status = 'paid'")) {
    if (params[0] !== "pi_1" && params[1] !== "unlock-1") return { rows: [], rowCount: 0 };
    return {
      rows: [{ id: "unlock-1", user_id: "viewer-1", track_id: "t2", album_id: null, amount_cents: "300", artist_user_id: "artist-1" }],
      rowCount: 1,
    };
  }
  if (sql.startsWith("UPDATE music_unlocks SET payment_intent_id")) return { rows: [], rowCount: 1 };
  if (sql.includes("UPDATE music_unlocks u") && sql.includes("SET status = 'refunded'")) {
    if (!revokeMatches || params[0] !== "pi_1") return { rows: [], rowCount: 0 };
    return { rows: [{ id: "unlock-1", owner_id: "artist-1", share: "210" }], rowCount: 1 };
  }
  if (sql.startsWith("SELECT 1 FROM music_unlocks")) return { rows: [], rowCount: 0 };
  if (sql.startsWith("UPDATE music_unlocks SET units_paid")) return { rows: [], rowCount: 1 };
  throw new Error("unexpected sql: " + sql.slice(0, 80));
}

import { createTrackUnlockIntent, createAlbumUnlockIntent, markMusicUnlockPaid, revokeMusicUnlockForPayment, musicUnlockRefId } from "@/lib/music/unlock";

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
  insertSql.length = 0;
  currentTrack = premiumTrack;
});

describe("music/unlock — card (Stripe, RON)", () => {
  it("refId determinist per user + țintă", () => {
    expect(musicUnlockRefId("u1", { trackId: "t2" })).toBe("music_unlock:u1:track:t2");
    expect(musicUnlockRefId("u1", { albumId: "al1" })).toBe("music_unlock:u1:album:al1");
  });

  it("piesă premium: creează PaymentIntent de 300 cenți cu metadata corectă", async () => {
    const r = await createTrackUnlockIntent({ userId: "viewer-1", trackId: "t2" });
    expect(r).toEqual({ ok: true, alreadyUnlocked: false, clientSecret: "secret_1", amountCents: 300 });
    expect(stripeCreateCalls[0]).toMatchObject({ amount: 300, currency: "ron", metadata: { kind: "music_track_unlock", trackId: "t2", userId: "viewer-1" }, payment_method_types: ["card"] });
    expect(stripeCreateCalls[0]).not.toHaveProperty("automatic_payment_methods");
  });

  it("piesă gratuită → not_premium", async () => {
    currentTrack = freeTrack;
    expect(await createTrackUnlockIntent({ userId: "viewer-1", trackId: "t1" })).toEqual({ ok: false, reason: "not_premium" });
  });

  it("preț nesetat (null) → price_not_set", async () => {
    currentTrack = { ...premiumTrack, price_cents: null };
    expect(await createTrackUnlockIntent({ userId: "viewer-1", trackId: "t2" })).toEqual({ ok: false, reason: "price_not_set" });
  });

  it("deja plătită → alreadyUnlocked, fără PaymentIntent nou", async () => {
    insertConflictStatus = "paid";
    expect(await createTrackUnlockIntent({ userId: "viewer-1", trackId: "t2" })).toEqual({ ok: true, alreadyUnlocked: true });
    expect(stripeCreateCalls).toHaveLength(0);
  });

  it("album fără preț propriu: suma pieselor premium cu discount (600 → 420 cenți)", async () => {
    const r = await createAlbumUnlockIntent({ userId: "viewer-1", albumId: "al1" });
    expect(r).toEqual({ ok: true, alreadyUnlocked: false, clientSecret: "secret_1", amountCents: 420 });
  });

  it("webhook payment_intent.succeeded: marchează plătit + creditează cota artistului (70%)", async () => {
    await markMusicUnlockPaid({ paymentIntentId: "pi_1", unlockId: "unlock-1", amountReceivedCents: 300, currency: "ron" });
    expect(creditCalls).toHaveLength(1);
    expect(creditCalls[0]).toMatchObject({ userId: "artist-1", amountCents: 210, refType: "music_artist_share", refId: "unlock-1" });
  });

  it("webhook idempotent: payment_intent necunoscut/deja plătit → no-op", async () => {
    await markMusicUnlockPaid({ paymentIntentId: "pi_unknown", unlockId: null, amountReceivedCents: 300, currency: "ron" });
    expect(creditCalls).toHaveLength(0);
  });
  it("folosește suma încasată efectiv de Stripe pentru cotă (nu prețul salvat)", async () => {
    await markMusicUnlockPaid({ paymentIntentId: "pi_1", unlockId: "unlock-1", amountReceivedCents: 600, currency: "ron" });
    expect(creditCalls[0]).toMatchObject({ amountCents: 420, refType: "music_artist_share" });
  });

  it("găsește deblocarea după unlockId din metadata chiar dacă intentul a fost înlocuit", async () => {
    await markMusicUnlockPaid({ paymentIntentId: "pi_old", unlockId: "unlock-1", amountReceivedCents: 300, currency: "ron" });
    expect(creditCalls).toHaveLength(1);
  });

  it("monedă neașteptată sau sumă 0 → acces neacordat, fără cotă", async () => {
    await markMusicUnlockPaid({ paymentIntentId: "pi_1", unlockId: "unlock-1", amountReceivedCents: 300, currency: "eur" });
    await markMusicUnlockPaid({ paymentIntentId: "pi_1", unlockId: "unlock-1", amountReceivedCents: 0, currency: "ron" });
    expect(creditCalls).toHaveLength(0);
  });

  it("refund total / dispută pierdută: revocă accesul și retrage cota (sold poate deveni negativ)", async () => {
    await expect(revokeMusicUnlockForPayment("pi_1", "refund")).resolves.toBe(true);
    expect(debitCalls).toHaveLength(1);
    expect(debitCalls[0]).toMatchObject({ userId: "artist-1", amountCents: 210, refType: "music_artist_share_reversal", refId: "unlock-1", allowNegative: true });
  });

  it("revocare pentru o plată care nu e deblocare → false, nimic debitat", async () => {
    revokeMatches = false;
    await expect(revokeMusicUnlockForPayment("pi_other", "refund")).resolves.toBe(false);
    expect(debitCalls).toHaveLength(0);
  });
});

describe("music/unlock — idempotență și plată dublă", () => {
  it("retry Stripe → o singură cotă; plata duplicată cu alt intent → rambursată", async () => {
    await markMusicUnlockPaid({ paymentIntentId: "pi_1", unlockId: "unlock-1", amountReceivedCents: 300, currency: "ron" });
    await markMusicUnlockPaid({ paymentIntentId: "pi_1", unlockId: "unlock-1", amountReceivedCents: 300, currency: "ron" });
    expect(creditCalls).toHaveLength(1);
    grantMatches = false;
    currentRow = { status: "paid", payment_intent_id: "pi_1" };
    await markMusicUnlockPaid({ paymentIntentId: "pi_2", unlockId: "unlock-1", amountReceivedCents: 300, currency: "ron" });
    expect(creditCalls).toHaveLength(1);
    expect(refundCalls).toHaveLength(1);
    expect(outcomes).toEqual([["pi_1", "granted"], ["pi_2", "duplicate_refunded"]]);
  });
});
