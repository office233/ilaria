import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getAuthUser } from "@/lib/auth/getAuthUser";

export const dynamic = "force-dynamic";

type Range = "7d" | "30d" | "90d" | "all";
const RANGE_DAYS: Record<Exclude<Range, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };

function parseRange(value: string | null): Range {
  if (value === "7d" || value === "30d" || value === "90d" || value === "all") return value;
  return "30d";
}

async function GET_impl(req: Request) {
  const auth = await getAuthUser();
  if (auth.role !== "creator" && auth.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!auth.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const creatorId = auth.userId;

  const url = new URL(req.url);
  const range = parseRange(url.searchParams.get("range"));
  const days = range === "all" ? null : RANGE_DAYS[range];
  const sinceClause = days ? `AND v.published_at >= now() - interval '${days} days'` : "";
  const eventsSinceClause = days ? `AND fe.occurred_at >= now() - interval '${days} days'` : "";
  const commSinceClause = days ? `AND c.created_at >= now() - interval '${days} days'` : "";

  const summaryQ = await dbQuery<{
    total_views: string;
    total_likes: string;
    total_comments: string;
    total_shares: string;
    total_saves: string;
    videos_published: string;
  }>(
    `SELECT
       COALESCE(SUM(v.view_count), 0)::text    AS total_views,
       COALESCE(SUM(v.like_count), 0)::text    AS total_likes,
       COALESCE(SUM(v.comment_count), 0)::text AS total_comments,
       COALESCE(SUM(v.share_count), 0)::text   AS total_shares,
       COALESCE(SUM(v.save_count), 0)::text    AS total_saves,
       COUNT(*)::text                          AS videos_published
       FROM videos v
       WHERE v.creator_id = $1
         AND v.status = 'ready'
         AND v.visibility = 'public'
         ${sinceClause}`,
    [creatorId],
  );
  const s = summaryQ.rows[0];

  const earningsQ = await dbQuery<{ cents: string; currency: string | null }>(
    `SELECT COALESCE(SUM(c.creator_amount_cents), 0)::text AS cents,
            MIN(c.currency) AS currency
       FROM commissions c
      WHERE c.creator_id = $1
        AND c.status IN ('approved','payable','paid')
        ${commSinceClause}`,
    [creatorId],
  );
  const totalEarningsCents = Number(earningsQ.rows[0]?.cents ?? "0");
  const earningsCurrency = (earningsQ.rows[0]?.currency || "RON").trim();

  let followersGained = 0;
  if (days) {
    const fQ = await dbQuery<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM follows
        WHERE following_user_id = $1
          AND created_at >= now() - interval '${days} days'`,
      [creatorId],
    );
    followersGained = Number(fQ.rows[0]?.count ?? "0");
  } else {
    const fQ = await dbQuery<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM follows WHERE following_user_id = $1`,
      [creatorId],
    );
    followersGained = Number(fQ.rows[0]?.count ?? "0");
  }

  const eventsQ = await dbQuery<{ event_type: string; cnt: string }>(
    `SELECT fe.event_type, COUNT(*)::text AS cnt
       FROM feed_events fe
       JOIN videos v ON v.id = fe.video_id
      WHERE v.creator_id = $1
        ${eventsSinceClause}
      GROUP BY fe.event_type`,
    [creatorId],
  );
  const evMap: Record<string, number> = {};
  for (const row of eventsQ.rows) evMap[row.event_type] = Number(row.cnt);
  const views = (evMap.video_view ?? 0) + (evMap.video_viewed ?? 0);
  const completions = evMap.completion ?? 0;
  const purchases = evMap.purchase ?? 0;
  const productClicks = evMap.product_click ?? 0;
  const avgCompletionRate = views > 0 ? completions / views : 0;
  const conversionRate = views > 0 ? purchases / views : 0;
  // CTR produse: click-uri pe produs raportate la views (FRONT 3, pct. 5).
  const productCtr = views > 0 ? productClicks / views : 0;

  // Câștiguri din atribuiri video → comenzi (video_attributions) + fond creator.
  const attribQ = await dbQuery<{ cents: string; orders: string }>(
    `SELECT COALESCE(SUM(va.commission_cents), 0)::text AS cents,
            COUNT(DISTINCT va.order_id)::text AS orders
       FROM video_attributions va
      WHERE va.creator_id = $1
        ${days ? `AND va.created_at >= now() - interval '${days} days'` : ""}`,
    [creatorId],
  );
  const attributedSalesCents = Number(attribQ.rows[0]?.cents ?? "0");
  const attributedOrders = Number(attribQ.rows[0]?.orders ?? "0");

  const fundQ = await dbQuery<{ cents: string }>(
    `SELECT COALESCE(SUM(p.amount_cents), 0)::text AS cents
       FROM creator_fund_payouts p
      WHERE p.creator_id = $1 AND p.status = 'paid'
        ${days ? `AND p.created_at >= now() - interval '${days} days'` : ""}`,
    [creatorId],
  );
  const creatorFundCents = Number(fundQ.rows[0]?.cents ?? "0");

  const topQ = await dbQuery<{
    id: string; title: string; thumbnail_url: string | null;
    view_count: string; like_count: string; earnings_cents: string;
  }>(
    `SELECT v.id, v.title, v.thumbnail_url,
            v.view_count::text, v.like_count::text,
            COALESCE((
              SELECT SUM(c.creator_amount_cents) FROM commissions c
               WHERE c.video_id = v.id AND c.status IN ('approved','payable','paid')
            ), 0)::text AS earnings_cents
       FROM videos v
      WHERE v.creator_id = $1 AND v.status = 'ready' AND v.visibility = 'public'
        ${sinceClause}
      ORDER BY v.view_count DESC LIMIT 10`,
    [creatorId],
  );
  const topVideos = topQ.rows.map((r) => ({
    id: r.id, title: r.title, thumbnail: r.thumbnail_url,
    views: Number(r.view_count), likes: Number(r.like_count),
    earningsCents: Number(r.earnings_cents),
  }));

  const timeDays = days ?? 90;
  const viewsTimeQ = await dbQuery<{ date: string; views: string }>(
    `SELECT to_char(date_trunc('day', fe.occurred_at), 'YYYY-MM-DD') AS date,
            COUNT(*)::text AS views
       FROM feed_events fe
       JOIN videos v ON v.id = fe.video_id
      WHERE v.creator_id = $1
        AND fe.event_type IN ('video_view','video_viewed')
        AND fe.occurred_at >= now() - interval '${timeDays} days'
      GROUP BY 1 ORDER BY 1 ASC`,
    [creatorId],
  );
  const viewsOverTime = viewsTimeQ.rows.map((r) => ({ date: r.date, views: Number(r.views) }));

  const earnTimeQ = await dbQuery<{ date: string; cents: string }>(
    `SELECT to_char(date_trunc('day', c.created_at), 'YYYY-MM-DD') AS date,
            COALESCE(SUM(c.creator_amount_cents), 0)::text AS cents
       FROM commissions c
      WHERE c.creator_id = $1 AND c.status IN ('approved','payable','paid')
        AND c.created_at >= now() - interval '${timeDays} days'
      GROUP BY 1 ORDER BY 1 ASC`,
    [creatorId],
  );
  const earningsOverTime = earnTimeQ.rows.map((r) => ({ date: r.date, cents: Number(r.cents) }));

  const countriesQ = await dbQuery<{ country: string; cnt: string }>(
    `SELECT fe.country, COUNT(*)::text AS cnt
       FROM feed_events fe
       JOIN videos v ON v.id = fe.video_id
      WHERE v.creator_id = $1 AND fe.country IS NOT NULL
        ${eventsSinceClause}
      GROUP BY fe.country ORDER BY 2 DESC LIMIT 5`,
    [creatorId],
  );
  const totalCountryRows = countriesQ.rows.reduce((acc, r) => acc + Number(r.cnt), 0);
  const audienceTopCountries = totalCountryRows > 0
    ? countriesQ.rows.map((r) => ({
      country: r.country,
      percentage: Math.round((Number(r.cnt) / totalCountryRows) * 100),
    }))
    : [];

  const audienceAgeBuckets: { bucket: string; percentage: number }[] = [];

  const body = {
    range,
    summary: {
      totalViews: Number(s?.total_views ?? "0"),
      totalLikes: Number(s?.total_likes ?? "0"),
      totalComments: Number(s?.total_comments ?? "0"),
      totalShares: Number(s?.total_shares ?? "0"),
      totalSaves: Number(s?.total_saves ?? "0"),
      totalEarningsCents,
      earningsCurrency,
      videosPublished: Number(s?.videos_published ?? "0"),
      avgCompletionRate,
      conversionRate,
      productCtr,
      productClicks,
      attributedSalesCents,
      attributedOrders,
      creatorFundCents,
      followersGained,
    },
    topVideos,
    viewsOverTime,
    earningsOverTime,
    audienceTopCountries,
    audienceAgeBuckets,
  };

  return NextResponse.json(body, { headers: { "Cache-Control": "private, no-store" } });
}

export const GET = withErrorHandling(GET_impl);
