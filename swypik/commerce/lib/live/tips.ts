import { withTransaction } from "@/lib/db";
import {
  creditUserTx,
  debitUserTx,
  InsufficientFundsError,
} from "@/lib/wallet/ledger";
import { publishRealtime, realtimeChannels } from "@/lib/realtime";

export type LiveTipPublic = {
  kind: "tip";
  id: string;
  amount_cents: number;
  currency: "RON";
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
};

export class LiveTipError extends Error {
  constructor(
    readonly code:
      | "stream_not_live"
      | "self_tip"
      | "insufficient_balance"
      | "wallet_currency_mismatch"
      | "idempotency_conflict",
    readonly status: 400 | 404 | 409,
  ) {
    super(code);
    this.name = "LiveTipError";
  }
}

type TipDbRow = {
  id: string;
  stream_id: string;
  sender_user_id: string;
  creator_user_id: string;
  amount_cents: string | number;
  currency: string;
  created_at: string;
};

function publicTip(
  row: TipDbRow,
  profile: { username: string | null; display_name: string | null; avatar_url: string | null },
): LiveTipPublic {
  return {
    kind: "tip",
    id: row.id,
    amount_cents: Number(row.amount_cents),
    currency: "RON",
    username: profile.username,
    display_name: profile.display_name,
    avatar_url: profile.avatar_url,
    created_at: row.created_at,
  };
}

export async function sendLiveTip(args: {
  streamId: string;
  senderUserId: string;
  amountCents: number;
  idempotencyKey: string;
}): Promise<{
  tip: LiveTipPublic;
  alreadyApplied: boolean;
  balanceAfterCents: number | null;
}> {
  const result = await withTransaction(async (q) => {
    // Replays must be resolved BEFORE checking the current stream/wallet state.
    // A successful tip may be retried after a network timeout when the live has
    // already ended; idempotency still has to return the original result.
    const replay = await q<TipDbRow>(
      `SELECT id::text, stream_id::text, sender_user_id::text,
              creator_user_id::text, amount_cents::text AS amount_cents,
              currency, created_at::text
         FROM live_tips
        WHERE sender_user_id = $1::uuid AND idempotency_key = $2::uuid
        LIMIT 1`,
      [args.senderUserId, args.idempotencyKey],
    );
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (
        row.stream_id !== args.streamId ||
        Number(row.amount_cents) !== args.amountCents
      ) {
        throw new LiveTipError("idempotency_conflict", 409);
      }
      const profile = await q<{
        username: string | null;
        display_name: string | null;
        avatar_url: string | null;
      }>(
        `SELECT username, display_name, avatar_url FROM users WHERE id = $1::uuid`,
        [args.senderUserId],
      );
      return {
        tip: publicTip(
          row,
          profile.rows[0] ?? { username: null, display_name: null, avatar_url: null },
        ),
        alreadyApplied: true,
        balanceAfterCents: null,
      };
    }

    const stream = await q<{ creator_user_id: string | null; status: string }>(
      `SELECT creator_user_id, status
         FROM live_streams
        WHERE id = $1::uuid
        FOR SHARE`,
      [args.streamId],
    );
    const creatorId = stream.rows[0]?.creator_user_id ?? null;
    if (!creatorId || stream.rows[0]?.status !== "live") {
      throw new LiveTipError("stream_not_live", 404);
    }
    if (creatorId === args.senderUserId) {
      throw new LiveTipError("self_tip", 400);
    }

    const wallets = await q<{ user_id: string; currency: string }>(
      `SELECT user_id, currency
         FROM wallet_balances
        WHERE user_id = ANY($1::uuid[])`,
      [[args.senderUserId, creatorId]],
    );
    if (wallets.rows.some((row) => row.currency !== "RON")) {
      throw new LiveTipError("wallet_currency_mismatch", 409);
    }

    const inserted = await q<TipDbRow>(
      `INSERT INTO live_tips
         (stream_id, sender_user_id, creator_user_id, amount_cents, currency, idempotency_key)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'RON', $5::uuid)
       ON CONFLICT (sender_user_id, idempotency_key) DO NOTHING
       RETURNING id::text, stream_id::text, sender_user_id::text,
                 creator_user_id::text, amount_cents::text AS amount_cents,
                 currency, created_at::text`,
      [
        args.streamId,
        args.senderUserId,
        creatorId,
        args.amountCents,
        args.idempotencyKey,
      ],
    );

    let row = inserted.rows[0];
    if (!row) {
      // Concurrent request won the UNIQUE(sender,idempotency_key) race after
      // our preflight SELECT. Re-read the winner.
      const existing = await q<TipDbRow>(
        `SELECT id::text, stream_id::text, sender_user_id::text,
                creator_user_id::text, amount_cents::text AS amount_cents,
                currency, created_at::text
           FROM live_tips
          WHERE sender_user_id = $1::uuid AND idempotency_key = $2::uuid
          LIMIT 1`,
        [args.senderUserId, args.idempotencyKey],
      );
      row = existing.rows[0];
      if (!row) throw new Error("live_tip_idempotency_winner_missing");
      if (
        row.stream_id !== args.streamId ||
        Number(row.amount_cents) !== args.amountCents
      ) {
        throw new LiveTipError("idempotency_conflict", 409);
      }
      const profile = await q<{
        username: string | null;
        display_name: string | null;
        avatar_url: string | null;
      }>(
        `SELECT username, display_name, avatar_url FROM users WHERE id = $1::uuid`,
        [args.senderUserId],
      );
      return {
        tip: publicTip(row, profile.rows[0] ?? { username: null, display_name: null, avatar_url: null }),
        alreadyApplied: true,
        balanceAfterCents: null,
      };
    }

    let debit;
    try {
      debit = await debitUserTx(q, {
        userId: args.senderUserId,
        amountCents: args.amountCents,
        refType: "live_tip",
        refId: row.id,
        description: "Swypik Live tip",
        metadata: {
          stream_id: args.streamId,
          creator_user_id: creatorId,
        },
      });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        throw new LiveTipError("insufficient_balance", 409);
      }
      throw error;
    }

    await creditUserTx(q, {
      userId: creatorId,
      amountCents: args.amountCents,
      refType: "live_tip",
      refId: row.id,
      description: "Swypik Live tip",
      metadata: {
        stream_id: args.streamId,
        sender_user_id: args.senderUserId,
      },
    });

    const profile = await q<{
      username: string | null;
      display_name: string | null;
      avatar_url: string | null;
    }>(
      `SELECT username, display_name, avatar_url FROM users WHERE id = $1::uuid`,
      [args.senderUserId],
    );

    return {
      tip: publicTip(row, profile.rows[0] ?? { username: null, display_name: null, avatar_url: null }),
      alreadyApplied: false,
      balanceAfterCents: debit.entry.balance_after_cents,
    };
  });

  if (!result.alreadyApplied) {
    await publishRealtime(realtimeChannels.liveChat(args.streamId), result.tip);
  }
  return result;
}
