"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { History } from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import type { PayoutRequestView } from "@/lib/creator/payouts";
import { formatMoneyCents } from "@/lib/i18n/currency";
import type { Locale } from "@/lib/i18n/config";

const STATUS_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  pending: "warning",
  processing: "info",
  paid: "success",
  rejected: "danger",
  failed: "danger",
};
const KNOWN_STATUSES = Object.keys(STATUS_TONE);

export function PayoutHistory({ payouts }: { payouts: PayoutRequestView[] }) {
  const t = useTranslations("creatorStudio.payouts");
  const format = useFormatter();
  const locale = useLocale() as Locale;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("historyTitle")}</CardTitle>
      </CardHeader>
      {payouts.length === 0 ? (
        <EmptyState icon={History} title={t("historyEmptyTitle")} description={t("historyEmptyBody")} className="py-6" />
      ) : (
        <ul className="divide-y divide-subtle">
          {payouts.map((p) => {
            const status = KNOWN_STATUSES.includes(p.status) ? p.status : "pending";
            const note = p.failureReason || p.adminNote;
            return (
              <li key={p.id} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold tabular-nums text-fg">{formatMoneyCents(p.amountCents, "RON", locale)}</p>
                  <p className="truncate text-xs text-muted">
                    {format.dateTime(new Date(p.requestedAt), { dateStyle: "medium" })}
                    {p.iban ? ` · ${t("toIban", { iban: p.iban })}` : ""}
                    {p.stripeTransferId ? ` · ${t("viaStripe")}` : ""}
                  </p>
                  {note && (status === "rejected" || status === "failed") ? (
                    <p className="mt-1 break-words text-xs text-danger">{note}</p>
                  ) : null}
                </div>
                <Badge tone={STATUS_TONE[status]} className="shrink-0">
                  {t(`status.${status}`)}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
