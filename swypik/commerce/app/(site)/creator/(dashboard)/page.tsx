import Link from "next/link";
import { redirect } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { Coins, Eye, Film, Upload, Users } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { getCreatorUserIdWithRoleCheck } from "@/lib/creator/session";
import { getCreatorEarnings, type CreatorEarnings } from "@/lib/creator/earnings";
import { formatMoneyCents } from "@/lib/i18n/currency";
import type { Locale } from "@/lib/i18n/config";
import { loadOverviewStats, loadRecentVideos, safeLoad } from "./_data";
import { KpiCard } from "./_components/KpiCard";
import { RecentVideosCard } from "./_components/RecentVideosCard";
import { StudioHeading } from "./_components/StudioHeading";

export const dynamic = "force-dynamic";

const EMPTY_EARNINGS: CreatorEarnings = {
  bySource: { commissions: 0, missions: 0, movies: 0, music: 0, fund: 0 },
  totalEarnedCents: 0,
  withdrawnCents: 0,
  balanceCents: 0,
  thisMonthEarnedCents: 0,
  pendingCommissionCents: 0,
  pendingPayoutCents: 0,
  recent: [],
};

export default async function CreatorOverviewPage() {
  const session = await getCreatorUserIdWithRoleCheck();
  if (!session) redirect("/become-a-creator");

  const [t, format, locale] = await Promise.all([
    getTranslations("creatorStudio.overview"),
    getFormatter(),
    getLocale(),
  ]);
  const money = (cents: number) => formatMoneyCents(cents, "RON", locale as Locale);

  const [stats, earnings, videos] = await Promise.all([
    safeLoad("stats", () => loadOverviewStats(session.userId), { views30d: 0, publishedVideos: 0, newFollowers30d: 0 }),
    safeLoad("earnings", () => getCreatorEarnings(session.userId), EMPTY_EARNINGS),
    safeLoad("videos", () => loadRecentVideos(session.userId), []),
  ]);

  return (
    <div className="space-y-4">
      <StudioHeading
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button asChild size="sm">
            <Link href="/upload">
              <Upload className="h-4 w-4" aria-hidden />
              {t("upload")}
            </Link>
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={Eye} label={t("kpiViews")} value={format.number(stats.views30d)} hint={t("last30d")} />
        <KpiCard
          icon={Coins}
          label={t("kpiEarnings")}
          value={money(earnings.totalEarnedCents)}
          hint={t("kpiBalance", { amount: money(earnings.balanceCents) })}
        />
        <KpiCard icon={Film} label={t("kpiPublished")} value={format.number(stats.publishedVideos)} />
        <KpiCard icon={Users} label={t("kpiFollowers")} value={format.number(stats.newFollowers30d)} hint={t("last30d")} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RecentVideosCard videos={videos} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t("payoutsTitle")}</CardTitle>
          </CardHeader>
          <dl className="space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-sm text-muted">{t("balance")}</dt>
              <dd className="text-lg font-bold tabular-nums text-fg">{money(earnings.balanceCents)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-sm text-muted">{t("pendingPayout")}</dt>
              <dd className="text-sm font-semibold tabular-nums text-fg">{money(earnings.pendingPayoutCents)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-sm text-muted">{t("thisMonth")}</dt>
              <dd className="text-sm font-semibold tabular-nums text-fg">{money(earnings.thisMonthEarnedCents)}</dd>
            </div>
          </dl>
          <div className="mt-4 grid gap-2">
            <Button asChild block>
              <Link href="/creator/payouts">{t("goPayouts")}</Link>
            </Button>
            <Button asChild block variant="secondary">
              <Link href="/creator/earnings">{t("goEarnings")}</Link>
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
