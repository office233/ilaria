/**
 * Admin — prezentare generală: indicatori reali pe interval (comenzi, GMV,
 * utilizatori noi, moderare, plăți, joburi eșuate), cozile de rezolvat și
 * ultimele acțiuni de admin.
 */
import { getTranslations } from "next-intl/server";
import { AdminPage, LinkTabs } from "@/components/admin/AdminPage";
import { AdminForbidden } from "@/components/admin/AdminForbidden";
import { requireAdminPage } from "@/lib/admin/guard";
import { hasPermission } from "@/lib/admin/permissions";
import { getAdminKpis, KPI_RANGES, parseKpiRange } from "@/lib/admin/kpis";
import OpsAlertsBar from "./OpsAlertsBar";
import { KpiGrid } from "./_dashboard/KpiGrid";
import { RecentActivity } from "./_dashboard/RecentActivity";

export const dynamic = "force-dynamic";

export default async function AdminDashboard({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  // Gate înainte de orice query: datele nu ajung în payload-ul RSC fără sesiune.
  const actor = await requireAdminPage("dashboard");
  if (!actor) return <AdminForbidden />;

  const t = await getTranslations("adminConsole.dashboard");
  const range = parseKpiRange((await searchParams).range);
  const kpis = await getAdminKpis(range);

  return (
    <AdminPage title={t("title")} description={t("subtitle")}>
      <LinkTabs
        label={t("rangeLabel")}
        active={range}
        tabs={KPI_RANGES.map((r) => ({ id: r, label: t(`range.${r}`), href: `/admin?range=${r}` }))}
      />
      <KpiGrid kpis={kpis} />
      <OpsAlertsBar />
      {hasPermission(actor.role, "audit") ? <RecentActivity /> : null}
    </AdminPage>
  );
}
