"use client";

import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { PAYOUT_STATUSES, PAYOUT_TONE, useFormatters, type CreatorPayoutRow, type PayoutAction } from "./shared";

type Props = {
  payout: CreatorPayoutRow;
  connectAvailable: boolean;
  onAction: (action: PayoutAction) => void;
  /** Namespace i18n (creator implicit; sellerii folosesc adminSellerPayouts). */
  ns?: string;
};

/** Card pentru o cerere de retragere a unui creator. */
export function PayoutCard({ payout: p, connectAvailable, onAction, ns = "adminCreatorPayouts" }: Props) {
  const t = useTranslations(ns);
  const f = useFormatters();
  const status = (PAYOUT_STATUSES as readonly string[]).includes(p.status) ? p.status : "unknown";
  const viaStripe = connectAvailable && p.connect_ready === true;
  const negativeBalance = Number(p.balance_cents) < 0;
  const name = p.display_name || (p.username ? `@${p.username}` : t("unknownCreator"));

  return (
    <Card padding="md">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={PAYOUT_TONE[p.status] ?? "neutral"}>{t(`status.${status}`)}</Badge>
            {connectAvailable ? (
              <Badge tone={p.connect_ready ? "success" : "neutral"}>
                {p.connect_ready ? t("connectReady") : t("connectNotReady")}
              </Badge>
            ) : null}
          </div>
          <p className="mt-2 truncate text-base font-semibold text-fg">{name}</p>
          <p className="truncate text-sm text-muted">
            {p.username && p.display_name ? `@${p.username}` : null}
            {p.username && p.display_name && p.email ? " · " : null}
            {p.email}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xl font-bold tabular-nums text-fg">{f.money(p.amount_cents)}</p>
          <p className={`text-xs tabular-nums ${negativeBalance ? "text-danger" : "text-subtle"}`}>
            {t("balance", { amount: f.money(p.balance_cents) })}
          </p>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-xs text-subtle">{t("iban")}</dt>
          <dd className="break-all font-mono text-sm text-fg">{p.iban || t("noIban")}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle">{t("requestedAt")}</dt>
          <dd className="text-fg">{f.dateTime(p.requested_at)}</dd>
        </div>
        {p.resolved_at ? (
          <div>
            <dt className="text-xs text-subtle">{t("resolvedAt")}</dt>
            <dd className="text-fg">{f.dateTime(p.resolved_at)}</dd>
          </div>
        ) : null}
        {p.stripe_transfer_id ? (
          <div className="min-w-0 sm:col-span-3">
            <dt className="text-xs text-subtle">{t("stripeTransfer")}</dt>
            <dd className="break-all font-mono text-sm text-fg">{p.stripe_transfer_id}</dd>
          </div>
        ) : null}
        {p.admin_note ? (
          <div className="min-w-0 sm:col-span-3">
            <dt className="text-xs text-subtle">{t("adminNote")}</dt>
            <dd className="text-muted">{p.admin_note}</dd>
          </div>
        ) : null}
      </dl>

      {p.failure_reason ? (
        <p className="mt-3 flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">{t("failureReason", { reason: p.failure_reason })}</span>
        </p>
      ) : null}

      {p.status === "pending" ? (
        <div className="mt-4 flex flex-col gap-2 border-t border-subtle pt-3 sm:flex-row sm:items-center">
          <p className="flex-1 text-xs text-subtle">{viaStripe ? t("willPayStripe") : t("willPayBank")}</p>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1 sm:flex-none" onClick={() => onAction("rejected")}>
              {t("actions.reject")}
            </Button>
            <Button className="flex-1 sm:flex-none" onClick={() => onAction("paid")}>
              {t("actions.markPaid")}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
