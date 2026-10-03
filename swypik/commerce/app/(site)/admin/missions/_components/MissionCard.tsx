"use client";

import { useTranslations } from "next-intl";
import { ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { FUNDING_TONE, MISSION_STATUS_TONE, useFormatters, type AdminMission } from "./shared";

/** Card de misiune: proprietar, stare, finanțare și cifrele escrow-ului. */
export function MissionCard({ mission, onOpen }: { mission: AdminMission; onOpen: () => void }) {
  const t = useTranslations("adminMissions");
  const f = useFormatters();
  const m = mission;

  const escrow: Array<{ key: string; value: number; tone?: string }> = [
    { key: "pool", value: m.poolCents },
    { key: "funded", value: m.fundedCents },
    { key: "paidOut", value: m.paidOutCents, tone: "text-success" },
    { key: "remaining", value: m.escrowRemainingCents },
    { key: "refunded", value: m.refundedCents },
  ];

  return (
    <Card padding="none" className="overflow-hidden">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-h-11 items-start gap-3 p-4 text-left transition-colors duration-fast hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={MISSION_STATUS_TONE[m.status] ?? "neutral"}>{t(`status.${statusKey(m.status)}`)}</Badge>
            <Badge tone={FUNDING_TONE[m.fundingStatus] ?? "neutral"}>
              {t(`funding.${fundingKey(m.fundingStatus)}`)}
            </Badge>
            {m.fundingSource === "platform" ? <Badge tone="brand">{t("platform")}</Badge> : null}
          </div>
          <h2 className="mt-2 line-clamp-2 text-base font-semibold text-fg">{m.title}</h2>
          <p className="mt-0.5 truncate text-sm text-muted">
            {m.fundingSource === "platform" ? t("platform") : m.sellerName || t("unknownSeller")}
            {" · "}
            {t("prizeTimes", { prize: f.money(m.prizeCents), count: m.maxWinners ?? 0 })}
          </p>
          <p className="mt-0.5 text-xs text-subtle">
            {t("period", { start: f.date(m.startsAt), end: f.date(m.endsAt) })}
          </p>
        </div>
        <ChevronRight aria-hidden className="mt-1 h-5 w-5 shrink-0 text-subtle" />
      </button>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-subtle bg-surface-2 px-4 py-3 text-sm sm:grid-cols-3 lg:grid-cols-7">
        {escrow.map((e) => (
          <div key={e.key} className="min-w-0">
            <dt className="truncate text-xs text-subtle">{t(`escrow.${e.key}`)}</dt>
            <dd className={`truncate font-semibold tabular-nums ${e.tone ?? "text-fg"}`}>{f.money(e.value)}</dd>
          </div>
        ))}
        <div className="min-w-0">
          <dt className="truncate text-xs text-subtle">{t("submissions")}</dt>
          <dd className="font-semibold tabular-nums text-fg">{f.num(m.submissions)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="truncate text-xs text-subtle">{t("winners")}</dt>
          <dd className="font-semibold tabular-nums text-fg">
            {f.num(m.winners)} / {f.num(m.maxWinners ?? 0)}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

const STATUSES = new Set(["active", "draft", "closed", "archived"]);
const FUNDINGS = new Set(["funded", "pending", "unfunded", "refunded"]);

export function statusKey(s: string): string {
  return STATUSES.has(s) ? s : "unknown";
}

export function fundingKey(s: string): string {
  return FUNDINGS.has(s) ? s : "unknown";
}
