/**
 * Admin — coada de moderare unificată:
 *   Rapoarte (clipuri raportate de utilizatori) · În așteptare (clipuri noi) ·
 *   Semnalate (cazuri deschise, ex. clasificatorul AI).
 */
import { getTranslations } from "next-intl/server";
import { AdminPage, LinkTabs } from "@/components/admin/AdminPage";
import { AdminForbidden } from "@/components/admin/AdminForbidden";
import { requireAdminPage } from "@/lib/admin/guard";
import {
  listFlaggedVideos,
  listPendingVideos,
  listReportGroups,
  moderationCounts,
  MODERATION_TABS,
  parseModerationTab,
  REPORT_REASONS,
  REPORT_STATUSES,
} from "@/lib/admin/moderation/queue";
import { ReportsList } from "./_components/ReportsList";
import { VideoQueue } from "./_components/VideoQueue";

export const dynamic = "force-dynamic";

type SearchParams = { tab?: string; status?: string; reason?: string };

export default async function ModerationPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const actor = await requireAdminPage("moderation");
  if (!actor) return <AdminForbidden />;

  const t = await getTranslations("adminConsole.moderation");
  const sp = await searchParams;
  const tab = parseModerationTab(sp.tab);
  const status = (REPORT_STATUSES as readonly string[]).includes(sp.status ?? "") ? (sp.status as string) : "open";
  const reason = (REPORT_REASONS as readonly string[]).includes(sp.reason ?? "") ? (sp.reason as string) : null;

  const counts = await moderationCounts().catch(() => null);

  let content: React.ReactNode;
  if (tab === "reports") {
    content = <ReportsList groups={await listReportGroups(status, reason)} status={status} reason={reason} />;
  } else if (tab === "pending") {
    content = <VideoQueue videos={await listPendingVideos()} flagged={false} />;
  } else {
    content = <VideoQueue videos={await listFlaggedVideos()} flagged />;
  }

  return (
    <AdminPage title={t("title")} description={t("subtitle")}>
      <LinkTabs
        label={t("tabsLabel")}
        active={tab}
        tabs={MODERATION_TABS.map((id) => ({
          id,
          label: t(`tab.${id}`),
          href: `/admin/moderation?tab=${id}`,
          count: counts?.[id] ?? null,
        }))}
      />
      {content}
    </AdminPage>
  );
}
