import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { CheckCircle2 } from "lucide-react";
import { AdminTable } from "@/components/admin/AdminTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Select } from "@/components/ui/Select";
import { REPORT_REASONS, REPORT_STATUSES, type ReportGroup } from "@/lib/admin/moderation/queue";

/** Rapoartele pe clipuri, grupate pe (clip, motiv), cu filtre de stare/motiv (GET). */
export async function ReportsList({
  groups,
  status,
  reason,
}: {
  groups: ReportGroup[];
  status: string;
  reason: string | null;
}) {
  const t = await getTranslations("adminModeration");
  const tc = await getTranslations("adminConsole.moderation");
  const locale = await getLocale();
  const fmt = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  // Etichetele existente din adminModeration: reasonSpam, reasonSexualContent, statusOpen…
  const pascal = (s: string) => s.replace(/(^|_)([a-z])/g, (_m, _u, c: string) => c.toUpperCase());
  const reasonLabel = (r: string) => ((REPORT_REASONS as readonly string[]).includes(r) ? t(`reason${pascal(r)}`) : r);

  return (
    <div className="space-y-4">
      <form method="GET" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="tab" value="reports" />
        <Select
          name="status"
          aria-label={tc("statusFilter")}
          defaultValue={status}
          className="w-auto"
          options={REPORT_STATUSES.map((s) => ({ value: s, label: t(`status${pascal(s)}`) }))}
        />
        <Select
          name="reason"
          aria-label={t("allCategories")}
          defaultValue={reason ?? ""}
          className="w-auto"
          options={[{ value: "", label: t("allCategories") }, ...REPORT_REASONS.map((r) => ({ value: r, label: reasonLabel(r) }))]}
        />
        <Button type="submit" variant="secondary">{t("filter")}</Button>
      </form>

      <AdminTable
        rows={groups}
        rowKey={(g) => `${g.video_id}-${g.reason}`}
        caption={tc("tab.reports")}
        empty={<EmptyState icon={CheckCircle2} title={t("noReports")} />}
        columns={[
          {
            key: "video",
            header: t("thVideo"),
            primary: true,
            cell: (g) => (
              <div className="flex items-center gap-3">
                {g.thumbnail_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={g.thumbnail_url} alt="" className="h-16 w-12 shrink-0 rounded-control bg-surface-2 object-cover" />
                ) : (
                  <div className="h-16 w-12 shrink-0 rounded-control bg-surface-2" aria-hidden />
                )}
                <div className="min-w-0">
                  <p className="line-clamp-2 font-semibold text-fg">{g.title || t("untitled")}</p>
                  {g.is_hidden ? <Badge tone="warning" size="sm">{t("hiddenBadge")}</Badge> : null}
                </div>
              </div>
            ),
          },
          { key: "creator", header: t("thCreator"), cell: (g) => (g.creator_username ? `@${g.creator_username}` : "—") },
          { key: "reason", header: t("thCategory"), cell: (g) => reasonLabel(g.reason) },
          { key: "count", header: t("thReports"), align: "end", cell: (g) => <span className="font-semibold">{g.reports_count}</span> },
          { key: "first", header: t("thFirst"), cell: (g) => fmt.format(new Date(g.first_reported_at)) },
        ]}
        actions={(g) => (
          <Button asChild size="sm">
            <Link href={`/admin/moderation/${g.sample_report_id}`}>{t("view")}</Link>
          </Button>
        )}
      />
    </div>
  );
}
