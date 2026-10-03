import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CalendarDays, Clock, Coins, Wallet } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/ErrorState";
import { getCreatorUserIdWithRoleCheck } from "@/lib/creator/session";
import { getCreatorEarnings, type CreatorEarnings } from "@/lib/creator/earnings";
import { formatMoneyCents } from "@/lib/i18n/currency";
import type { Locale } from "@/lib/i18n/config";
import { logger } from "@/lib/logger";
import { KpiCard } from "../_components/KpiCard";
import { StudioHeading } from "../_components/StudioHeading";
import { LedgerActivity } from "./_components/LedgerActivity";
import { SourceBreakdown } from "./_components/SourceBreakdown";

export const dynamic = "force-dynamic";

export default async function CreatorEarningsPage() {
  const session = await getCreatorUserIdWithRoleCheck();
  if (!session) redirect("/become-a-creator");

  const [t, locale] = await Promise.all([getTranslations("creatorStudio.earnings"), getLocale()]);
  const money = (cents: number) => formatMoneyCents(cents, "RON", locale as Locale);

  let earnings: CreatorEarnings;
  try {
    earnings = await getCreatorEarnings(session.userId);
  } catch (err) {
    logger.error({ err, userId: session.userId }, "[creator/earnings] load failed");
    return (
      <div>
        <StudioHeading title={t("title")} />
        <Card>
          <ErrorState title={t("loadErrorTitle")} description={t("loadErrorBody")} />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <StudioHeading title={t("title")} subtitle={t("subtitle")} />

      <Card variant="elevated" padding="lg">
        <p className="flex items-center gap-2 text-sm text-muted">
          <Wallet className="h-4 w-4" aria-hidden />
          {t("balance")}
        </p>
        <p className="mt-1 break-words text-3xl font-bold tabular-nums text-fg">{money(earnings.balanceCents)}</p>
        {earnings.pendingPayoutCents > 0 ? (
          <p className="mt-1 text-sm text-muted">{t("pendingPayout", { amount: money(earnings.pendingPayoutCents) })}</p>
        ) : null}
        <Button asChild block className="mt-4 sm:w-auto">
          <Link href="/creator/payouts">{t("withdrawCta")}</Link>
        </Button>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <KpiCard icon={Coins} label={t("totalEarned")} value={money(earnings.totalEarnedCents)} />
        <KpiCard icon={CalendarDays} label={t("thisMonth")} value={money(earnings.thisMonthEarnedCents)} />
        <div className="col-span-2 lg:col-span-1">
          <KpiCard icon={Clock} label={t("pendingEstimated")} value={money(earnings.pendingCommissionCents)} />
        </div>
      </div>
      <p className="text-xs text-muted">{t("pendingExplain")}</p>

      <div className="grid gap-4 lg:grid-cols-2">
        <SourceBreakdown bySource={earnings.bySource} totalCents={earnings.totalEarnedCents} />
        <LedgerActivity entries={earnings.recent} />
      </div>

      {earnings.withdrawnCents > 0 ? (
        <p className="text-sm text-muted">{t("withdrawnTotal", { amount: money(earnings.withdrawnCents) })}</p>
      ) : null}
    </div>
  );
}
