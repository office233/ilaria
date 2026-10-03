/**
 * Admin Moderation — detail raport video
 */
import { dbQuery } from "@/lib/db";
import { getTranslations, getLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { isUuidParam } from "@/lib/validation/params";
import Link from "next/link";
import ModerationActions from "./ModerationActions";
import { requireAdminPage } from "@/lib/admin/guard";
import { AdminForbidden } from "@/components/admin/AdminForbidden";

export const dynamic = "force-dynamic";

async function getReportDetail(reportId: string) {
  const { rows } = await dbQuery(
    `
    SELECT mr.id, mr.reason, mr.status, mr.note, mr.created_at,
           mr.target_video_id,
           v.title, v.thumbnail_url, v.playback_url, v.is_hidden, v.status AS video_status,
           u.id AS creator_id, u.username AS creator_username,
           u.suspended_until,
           rep.username AS reporter_username
    FROM moderation_reports mr
    LEFT JOIN videos v ON v.id = mr.target_video_id
    LEFT JOIN users u ON u.id = v.creator_id
    LEFT JOIN users rep ON rep.id = mr.reporter_user_id
    WHERE mr.id = $1
    LIMIT 1
    `,
    [reportId]
  );
  return rows[0] || null;
}

type RelatedReport = {
  id: string;
  reason: string;
  status: string;
  note: string | null;
  created_at: string;
  reporter_username: string | null;
};

async function getRelatedReports(videoId: string): Promise<RelatedReport[]> {
  const { rows } = await dbQuery(
    `
    SELECT mr.id, mr.reason, mr.status, mr.note, mr.created_at,
           u.username AS reporter_username
    FROM moderation_reports mr
    LEFT JOIN users u ON u.id = mr.reporter_user_id
    WHERE mr.target_video_id = $1
    ORDER BY mr.created_at DESC
    LIMIT 50
    `,
    [videoId]
  );
  return rows;
}

export default async function ModerationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await requireAdminPage("moderation"))) return <AdminForbidden />;
  const t = await getTranslations("adminModeration");
  const locale = await getLocale();
  const REASONS: Record<string, string> = {
    spam: t("reasonSpam"),
    harassment: t("reasonHarassment"),
    hate: t("reasonHate"),
    violence: t("reasonViolence"),
    sexual_content: t("reasonSexualContent"),
    scam: t("reasonScam"),
    copyright: t("reasonCopyright"),
    other: t("reasonOther"),
  };
  const { id } = await params;
  if (!isUuidParam(id)) return notFound();
  const r = await getReportDetail(id);
  if (!r) return notFound();
  const related = r.target_video_id ? await getRelatedReports(r.target_video_id) : [];

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-gutter py-5 md:px-8 md:py-8">
      <Link href="/admin/moderation" className="inline-flex min-h-11 items-center text-sm font-medium text-brand">
        ← {t("backToQueue")}
      </Link>
      <h1 className="text-2xl font-semibold text-fg">{t("videoReportTitle")}</h1>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-card border border-subtle bg-surface p-4">
          <h2 className="mb-3 font-semibold text-fg">{t("reportedVideo")}</h2>
          <div className="flex gap-3">
            {r.thumbnail_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={r.thumbnail_url}
                alt=""
                className="h-44 w-32 shrink-0 rounded-control bg-surface-2 object-cover"
              />
            ) : (
              <div className="h-44 w-32 shrink-0 rounded-control bg-surface-2" aria-hidden />
            )}
            <div className="flex-1 text-sm">
              <div className="font-semibold">{r.title || t("untitled")}</div>
              <div className="text-muted mt-1">
                {t("creatorLabel")}:{" "}
                {r.creator_username ? (
                  <Link href={`/u/${r.creator_username}`} className="text-brand">
                    @{r.creator_username}
                  </Link>
                ) : (
                  "—"
                )}
              </div>
              <div className="text-muted">{t("statusLabel")}: {r.video_status}</div>
              {r.is_hidden && (
                <span className="mt-1 inline-block text-xs font-semibold text-warning">
                  {t("hiddenBadge")}
                </span>
              )}
              {r.suspended_until && (
                <div className="mt-1 text-xs font-semibold text-danger">
                  {t("suspendedUntil")}{" "}
                  {new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(r.suspended_until))}
                </div>
              )}
              {r.playback_url && (
                <a
                  href={r.playback_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex min-h-9 items-center text-sm font-medium text-brand"
                >
                  {t("openPlayback")} ↗
                </a>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-card border border-subtle bg-surface p-4">
          <h2 className="mb-3 font-semibold text-fg">{t("currentReport")}</h2>
          <dl className="text-sm space-y-1">
            <div>
              <dt className="inline font-semibold">{t("categoryLabel")}: </dt>
              <dd className="inline">{REASONS[r.reason] || r.reason}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">{t("statusLabel")}: </dt>
              <dd className="inline">{r.status}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">{t("reporterLabel")}: </dt>
              <dd className="inline">
                {r.reporter_username ? `@${r.reporter_username}` : t("anonymous")}
              </dd>
            </div>
            <div>
              <dt className="inline font-semibold">{t("dateLabel")}: </dt>
              <dd className="inline">
                {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(r.created_at))}
              </dd>
            </div>
            {r.note && (
              <div className="mt-2">
                <dt className="font-semibold">{t("noteLabel")}</dt>
                <dd className="text-muted whitespace-pre-wrap">{r.note}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>

      <ModerationActions reportId={r.id} videoId={r.target_video_id} creatorId={r.creator_id} />

      <div className="rounded-card border border-subtle bg-surface p-4">
        <h2 className="mb-3 font-semibold text-fg">{t("allReportsOnVideo", { count: related.length })}</h2>
        <ul className="text-sm divide-y divide-subtle">
          {related.map((rr) => (
            <li key={rr.id} className="py-2">
              <span className="font-semibold">{REASONS[rr.reason] || rr.reason}</span>
              <span className="text-muted">
                {" "}
                · {rr.reporter_username ? `@${rr.reporter_username}` : t("anonymous")} ·{" "}
                {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(rr.created_at))} · {rr.status}
              </span>
              {rr.note && <div className="text-muted mt-1">{rr.note}</div>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
