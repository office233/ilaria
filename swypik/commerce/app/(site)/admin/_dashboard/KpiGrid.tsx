import { getLocale, getTranslations } from "next-intl/server";
import { AlertOctagon, Banknote, Flag, ShieldAlert, ShoppingBag, UserPlus, Video, Wallet } from "lucide-react";
import { KpiCard } from "@/components/admin/KpiCard";
import type { AdminKpis, MoneyTotal } from "@/lib/admin/kpis";

function formatMoney(total: MoneyTotal, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: total.currency, maximumFractionDigits: 0 }).format(
      total.cents / 100,
    );
  } catch {
    return `${(total.cents / 100).toFixed(0)} ${total.currency}`;
  }
}

/** Grila de indicatori; o metrică indisponibilă apare ca „—”. */
export async function KpiGrid({ kpis }: { kpis: AdminKpis }) {
  const t = await getTranslations("adminConsole.dashboard");
  const locale = await getLocale();
  const nf = new Intl.NumberFormat(locale);
  const num = (v: number | null) => (v === null ? "—" : nf.format(v));
  const period = t(`range.${kpis.range}`);

  const [firstGmv, ...otherGmv] = kpis.gmv ?? [];
  const payouts = kpis.payoutRequests;
  const jobs = kpis.failedJobs;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard icon={ShoppingBag} label={t("orders")} value={num(kpis.orders)} hint={period} href="/admin/orders" />
      <KpiCard
        icon={Banknote}
        label={t("gmv")}
        value={kpis.gmv === null ? "—" : firstGmv ? formatMoney(firstGmv, locale) : nf.format(0)}
        hint={otherGmv.length ? otherGmv.map((g) => formatMoney(g, locale)).join(" · ") : period}
      />
      <KpiCard icon={UserPlus} label={t("newUsers")} value={num(kpis.newUsers)} hint={period} href="/admin/users" />
      <KpiCard
        icon={Video}
        label={t("videosPending")}
        value={num(kpis.videosPending)}
        tone={kpis.videosPending ? "warning" : "neutral"}
        href="/admin/moderation?tab=pending"
      />
      <KpiCard
        icon={ShieldAlert}
        label={t("videosFlagged")}
        value={num(kpis.videosFlagged)}
        tone={kpis.videosFlagged ? "danger" : "neutral"}
        href="/admin/moderation?tab=flagged"
      />
      <KpiCard
        icon={Flag}
        label={t("openReports")}
        value={num(kpis.openReports)}
        tone={kpis.openReports ? "warning" : "neutral"}
        href="/admin/moderation"
      />
      <KpiCard
        icon={Wallet}
        label={t("payoutRequests")}
        value={payouts === null ? "—" : nf.format(payouts.courier + payouts.creator)}
        hint={payouts ? t("payoutSplit", { courier: payouts.courier, creator: payouts.creator }) : undefined}
        tone={payouts && payouts.courier + payouts.creator > 0 ? "warning" : "neutral"}
        href="/admin/creator-payouts"
      />
      <KpiCard
        icon={AlertOctagon}
        label={t("failedJobs")}
        value={jobs === null ? "—" : nf.format(jobs.cron + jobs.video)}
        hint={jobs ? t("jobSplit", { cron: jobs.cron, video: jobs.video }) : undefined}
        tone={jobs && jobs.cron + jobs.video > 0 ? "danger" : "neutral"}
        href="/admin/cron"
      />
    </div>
  );
}
