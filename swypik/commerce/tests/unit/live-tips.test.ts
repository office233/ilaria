import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class MockInsufficientFundsError extends Error {
    constructor(
      public readonly balanceCents: number,
      public readonly requestedCents: number,
    ) {
      super("insufficient_funds");
      this.name = "InsufficientFundsError";
    }
  }
  return {
    q: vi.fn(),
    debit: vi.fn(),
    credit: vi.fn(),
    publish: vi.fn(),
    InsufficientFundsError: MockInsufficientFundsError,
  };
});

vi.mock("@/lib/db", () => ({
  withTransaction: async (fn: (q: typeof h.q) => Promise<unknown>) => fn(h.q),
}));
vi.mock("@/lib/wallet/ledger", () => ({
  debitUserTx: h.debit,
  creditUserTx: h.credit,
  InsufficientFundsError: h.InsufficientFundsError,
}));
vi.mock("@/lib/realtime", () => ({
  publishRealtime: h.publish,
  realtimeChannels: { liveChat: (streamId: string) => "live:chat:" + streamId },
}));

import { LiveTipError, sendLiveTip } from "@/lib/live/tips";

const STREAM = "11111111-1111-4111-8111-111111111111";
const SENDER = "22222222-2222-4222-8222-222222222222";
const CREATOR = "33333333-3333-4333-8333-333333333333";
const TIP = "44444444-4444-4444-8444-444444444444";
const IDEM = "55555555-5555-4555-8555-555555555555";

const tipRow = {
  id: TIP,
  stream_id: STREAM,
  sender_user_id: SENDER,
  creator_user_id: CREATOR,
  amount_cents: "1000",
  currency: "RON",
  created_at: "2026-09-30T00:00:00Z",
};

beforeEach(() => {
  h.q.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes("FROM live_tips")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT creator_user_id, status")) {
      return { rows: [{ creator_user_id: CREATOR, status: "live" }], rowCount: 1 };
    }
    if (sql.includes("FROM wallet_balances")) {
      return {
        rows: [
          { user_id: SENDER, currency: "RON" },
          { user_id: CREATOR, currency: "RON" },
        ],
        rowCount: 2,
      };
    }
    if (sql.includes("INSERT INTO live_tips")) {
      return { rows: [tipRow], rowCount: 1 };
    }
    if (sql.includes("SELECT username, display_name, avatar_url")) {
      return {
        rows: [{ username: "ana", display_name: "Ana", avatar_url: null }],
        rowCount: 1,
      };
    }
    throw new Error("unexpected sql: " + sql);
  });
  h.debit.mockReset().mockResolvedValue({
    alreadyApplied: false,
    entry: { balance_after_cents: 2500 },
  });
  h.credit.mockReset().mockResolvedValue({
    alreadyApplied: false,
    entry: { balance_after_cents: 1000 },
  });
  h.publish.mockReset().mockResolvedValue(true);
});

describe("sendLiveTip", () => {
  it("atomically debits the viewer, credits the creator and publishes after success", async () => {
    const result = await sendLiveTip({
      streamId: STREAM,
      senderUserId: SENDER,
      amountCents: 1000,
      idempotencyKey: IDEM,
    });

    expect(h.debit).toHaveBeenCalledWith(
      h.q,
      expect.objectContaining({
        userId: SENDER,
        amountCents: 1000,
        refType: "live_tip",
        refId: TIP,
      }),
    );
    expect(h.credit).toHaveBeenCalledWith(
      h.q,
      expect.objectContaining({
        userId: CREATOR,
        amountCents: 1000,
        refType: "live_tip",
        refId: TIP,
      }),
    );
    expect(result).toMatchObject({
      alreadyApplied: false,
      balanceAfterCents: 2500,
      tip: {
        kind: "tip",
        id: TIP,
        amount_cents: 1000,
        currency: "RON",
        display_name: "Ana",
      },
    });
    expect(h.publish).toHaveBeenCalledWith(
      "live:chat:" + STREAM,
      expect.objectContaining({ kind: "tip", id: TIP }),
    );
  });

  it("replays the same idempotency key before checking current stream/wallet state", async () => {
    h.q.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM live_tips")) return { rows: [tipRow], rowCount: 1 };
      if (sql.includes("SELECT username, display_name, avatar_url")) {
        return { rows: [{ username: "ana", display_name: "Ana", avatar_url: null }], rowCount: 1 };
      }
      throw new Error("unexpected sql: " + sql);
    });

    const result = await sendLiveTip({
      streamId: STREAM,
      senderUserId: SENDER,
      amountCents: 1000,
      idempotencyKey: IDEM,
    });
    expect(result.alreadyApplied).toBe(true);
    expect(h.q.mock.calls.some(([sql]) => String(sql).includes("SELECT creator_user_id, status"))).toBe(false);
    expect(h.q.mock.calls.some(([sql]) => String(sql).includes("FROM wallet_balances"))).toBe(false);
    expect(h.debit).not.toHaveBeenCalled();
    expect(h.credit).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("rejects self-tip before touching wallets", async () => {
    h.q
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ creator_user_id: SENDER, status: "live" }],
        rowCount: 1,
      });
    await expect(
      sendLiveTip({
        streamId: STREAM,
        senderUserId: SENDER,
        amountCents: 1000,
        idempotencyKey: IDEM,
      }),
    ).rejects.toMatchObject({ code: "self_tip", status: 400 });
    expect(h.debit).not.toHaveBeenCalled();
    expect(h.credit).not.toHaveBeenCalled();
  });

  it("maps insufficient wallet funds and never credits the creator", async () => {
    h.debit.mockRejectedValueOnce(new h.InsufficientFundsError(500, 1000));
    await expect(
      sendLiveTip({
        streamId: STREAM,
        senderUserId: SENDER,
        amountCents: 1000,
        idempotencyKey: IDEM,
      }),
    ).rejects.toMatchObject({ code: "insufficient_balance", status: 409 });
    expect(h.credit).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("rejects idempotency reuse with a different amount", async () => {
    h.q.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM live_tips")) return { rows: [tipRow], rowCount: 1 };
      throw new Error("unexpected sql: " + sql);
    });
    await expect(
      sendLiveTip({
        streamId: STREAM,
        senderUserId: SENDER,
        amountCents: 2500,
        idempotencyKey: IDEM,
      }),
    ).rejects.toBeInstanceOf(LiveTipError);
    expect(h.debit).not.toHaveBeenCalled();
  });

  it("rejects a non-RON wallet rather than mixing currencies", async () => {
    h.q.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM live_tips")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT creator_user_id, status")) {
        return { rows: [{ creator_user_id: CREATOR, status: "live" }], rowCount: 1 };
      }
      if (sql.includes("FROM wallet_balances")) {
        return { rows: [{ user_id: SENDER, currency: "EUR" }], rowCount: 1 };
      }
      throw new Error("unexpected sql: " + sql);
    });
    await expect(
      sendLiveTip({
        streamId: STREAM,
        senderUserId: SENDER,
        amountCents: 1000,
        idempotencyKey: IDEM,
      }),
    ).rejects.toMatchObject({ code: "wallet_currency_mismatch", status: 409 });
    expect(h.debit).not.toHaveBeenCalled();
  });
});