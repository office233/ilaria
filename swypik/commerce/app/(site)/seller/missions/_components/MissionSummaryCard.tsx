"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { CreditCard, ExternalLink, ListChecks } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { FUNDING_TONE, STATUS_TONE, canFund, useFormatRon, type ManagedMission } from "./shared";

type Props = {
  mission: ManagedMission;
  onFund: (m: ManagedMission) => void;
  onOpen: (m: ManagedMission) => void;
};

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-control bg-surface-2 px-3 py-2">
      <p className="text-xs text-muted">{label}</p>
      <p className={strong ? "font-semibold text-fg" : "font-medium text-fg"}>{value}</p>
    </div>
  );
}

/** Misiunea proprie: stare, finanțare și situația escrow-ului. */
export function MissionSummaryCard({ mission: m, onFund, onOpen }: Props) {
  const t = useTranslations("sellerMissions");
  const ron = useFormatRon();
  const isPublic = m.status === "active" && m.fundingStatus === "funded";

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 font-semibold text-fg">{m.title}</h2>
          <p className="mt-0.5 text-xs text-muted">
            {t("card.prizeLine", { amount: ron(m.prizeCents), count: m.maxWinners ?? 0 })}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={STATUS_TONE[m.status] ?? "neutral"}>{t(`status.${m.status in STATUS_TONE ? m.status : "draft"}`)}</Badge>
          <Badge tone={FUNDING_TONE[m.fundingStatus] ?? "neutral"}>
            {t(`funding.${m.fundingStatus in FUNDING_TONE ? m.fundingStatus : "unfunded"}`)}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label={t("stats.pool")} value={ron(m.poolCents)} strong />
        <Stat label={t("stats.funded")} value={ron(m.fundedCents)} />
        <Stat label={t("stats.paidOut")} value={ron(m.paidOutCents)} />
        <Stat label={t("stats.remaining")} value={ron(m.escrowRemainingCents)} strong />
        <Stat label={t("stats.refunded")} value={ron(m.refundedCents)} />
        <Stat
          label={t("stats.entries")}
          value={t("stats.entriesValue", { submissions: m.submissions, winners: m.winners })}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {canFund(m) ? (
          <Button onClick={() => onFund(m)}>
            <CreditCard className="h-4 w-4" aria-hidden /> {t("actions.fund", { amount: ron(m.poolCents) })}
          </Button>
        ) : null}
        <Button variant="secondary" onClick={() => onOpen(m)}>
          <ListChecks className="h-4 w-4" aria-hidden /> {t("actions.manage")}
        </Button>
        {isPublic ? (
          <Button asChild variant="ghost">
            <Link href={`/missions/${m.slug}`} target="_blank" rel="noopener">
              <ExternalLink className="h-4 w-4" aria-hidden /> {t("actions.viewPublic")}
            </Link>
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
