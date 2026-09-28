/**
 * Citiri pentru panourile de administrare a misiunilor (seller + admin):
 * misiunile cu starea escrow-ului și înscrierile de jurizat.
 */
import { dbQuery } from "@/lib/db";
import { escrowRemainingCents, missionPoolCents } from "./config";

type ManagedRow = {
  id: string;
  slug: string;
  title: string;
  brief: string | null;
  status: string;
  seller_id: string | null;
  seller_name: string | null;
  funding_source: string;
  funding_status: string;
  prize_amount_minor: number;
  max_winners: number | null;
  funded_cents: string;
  paid_out_cents: string;
  refunded_cents: string;
  starts_at: string;
  ends_at: string | null;
  created_at: string;
  submissions: number;
  winners: number;
};

export type ManagedMission = {
  id: string;
  slug: string;
  title: string;
  brief: string | null;
  status: string;
  sellerId: string | null;
  sellerName: string | null;
  fundingSource: string;
  fundingStatus: string;
  prizeCents: number;
  maxWinners: number | null;
  poolCents: number;
  fundedCents: number;
  paidOutCents: number;
  refundedCents: number;
  escrowRemainingCents: number;
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
  submissions: number;
  winners: number;
};

function toManaged(r: ManagedRow): ManagedMission {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    brief: r.brief,
    status: r.status,
    sellerId: r.seller_id,
    sellerName: r.seller_name,
    fundingSource: r.funding_source,
    fundingStatus: r.funding_status,
    prizeCents: Number(r.prize_amount_minor),
    maxWinners: r.max_winners,
    poolCents: missionPoolCents(Number(r.prize_amount_minor), Number(r.max_winners ?? 0)),
    fundedCents: Number(r.funded_cents),
    paidOutCents: Number(r.paid_out_cents),
    refundedCents: Number(r.refunded_cents),
    escrowRemainingCents: escrowRemainingCents(r),
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    createdAt: r.created_at,
    submissions: Number(r.submissions),
    winners: Number(r.winners),
  };
}

export async function listManagedMissions(scope: { sellerId?: string; status?: string }): Promise<ManagedMission[]> {
  const { rows } = await dbQuery<ManagedRow>(
    `SELECT m.id, m.slug, m.title, m.brief, m.status, m.seller_id, se.name AS seller_name,
            m.funding_source, m.funding_status, m.prize_amount_minor, m.max_winners,
            m.funded_cents::text, m.paid_out_cents::text, m.refunded_cents::text,
            m.starts_at, m.ends_at, m.created_at,
            (SELECT COUNT(*)::int FROM creator_mission_submissions s
              WHERE s.mission_id = m.id AND s.status <> 'rejected') AS submissions,
            (SELECT COUNT(*)::int FROM creator_mission_submissions s
              WHERE s.mission_id = m.id AND s.status = 'paid') AS winners
       FROM creator_missions m
       LEFT JOIN sellers se ON se.id = m.seller_id
      WHERE ($1::uuid IS NULL OR m.seller_id = $1::uuid)
        AND ($2::text IS NULL OR m.status = $2::text)
      ORDER BY m.created_at DESC
      LIMIT 200`,
    [scope.sellerId ?? null, scope.status ?? null],
  );
  return rows.map(toManaged);
}

export type ManagedSubmission = {
  id: string;
  status: string;
  submittedAt: string;
  paidAt: string | null;
  payoutCents: number;
  rejectionReason: string | null;
  video: { id: string; title: string | null; thumbnailUrl: string | null; status: string | null; views: number };
  creator: { id: string; username: string | null; displayName: string | null };
};

export async function listMissionSubmissions(missionId: string, scope: { sellerId?: string }): Promise<ManagedSubmission[] | null> {
  const { rows: owner } = await dbQuery<{ id: string }>(
    `SELECT id FROM creator_missions WHERE id = $1 AND ($2::uuid IS NULL OR seller_id = $2::uuid)`,
    [missionId, scope.sellerId ?? null],
  );
  if (!owner[0]) return null;
  const { rows } = await dbQuery<{
    id: string;
    status: string;
    submitted_at: string;
    paid_at: string | null;
    payout_minor: number;
    rejection_reason: string | null;
    video_id: string;
    video_title: string | null;
    thumbnail_url: string | null;
    video_status: string | null;
    view_count: number | null;
    user_id: string;
    username: string | null;
    display_name: string | null;
  }>(
    `SELECT s.id, s.status, s.submitted_at, s.paid_at, s.payout_minor, s.rejection_reason,
            v.id AS video_id, v.title AS video_title, v.thumbnail_url, v.status AS video_status, v.view_count,
            u.id AS user_id, u.username, u.display_name
       FROM creator_mission_submissions s
       JOIN videos v ON v.id = s.video_id
       JOIN users u ON u.id = s.user_id
      WHERE s.mission_id = $1
      ORDER BY (s.status = 'paid') DESC, v.view_count DESC NULLS LAST, s.submitted_at ASC
      LIMIT 300`,
    [missionId],
  );
  return rows.map((r) => ({
    id: r.id,
    status: r.status === "approved" ? "submitted" : r.status,
    submittedAt: r.submitted_at,
    paidAt: r.paid_at,
    payoutCents: Number(r.payout_minor),
    rejectionReason: r.rejection_reason,
    video: {
      id: r.video_id,
      title: r.video_title,
      thumbnailUrl: r.thumbnail_url,
      status: r.video_status,
      views: Number(r.view_count ?? 0),
    },
    creator: { id: r.user_id, username: r.username, displayName: r.display_name },
  }));
}
