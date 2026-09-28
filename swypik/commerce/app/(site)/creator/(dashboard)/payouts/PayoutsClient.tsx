"use client";

import { useCallback, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Banknote, Info, Wallet } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { formatMoneyCents } from "@/lib/i18n/currency";
import type { Locale } from "@/lib/i18n/config";
import { ConnectSection } from "./_components/ConnectSection";
import { PayoutHistory } from "./_components/PayoutHistory";
import { WithdrawSheet } from "./_components/WithdrawSheet";
import { OPEN_PAYOUT_STATUSES, type PayoutsData } from "./_components/types";

export default function PayoutsClient({ initial }: { initial: PayoutsData }) {
  const t = useTranslations("creatorStudio.payouts");
  const locale = useLocale() as Locale;
  const money = (c: number) => formatMoneyCents(c, "RON", locale);
  const [data, setData] = useState<PayoutsData>(initial);
  const [sheetOpen, setSheetOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/creator/payouts", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as PayoutsData);
    } catch {
      // Datele vechi rămân afișate; cererea a reușit deja (toast în sheet).
    }
  }, []);

  const { readiness, balanceCents } = data;
  const heldCents = data.heldCents ?? 0;
  const withdrawableCents = Math.max(0, balanceCents - heldCents);
  const hasOpenRequest = data.payouts.some((p) => OPEN_PAYOUT_STATUSES.includes(p.status));
  const belowMin = withdrawableCents < readiness.minCents;
  const methodBody =
    readiness.method === "stripe"
      ? t("methodStripeBody")
      : readiness.connectAvailable
        ? t("methodBankConnectBody")
        : t("methodBankBody");

  return (
    <div className="space-y-4">
      <Card variant="elevated" padding="lg">
        <p className="flex items-center gap-2 text-sm text-muted">
          <Wallet className="h-4 w-4" aria-hidden />
          {t("balance")}
        </p>
        <p className="mt-1 break-words text-3xl font-bold tabular-nums text-fg">{money(balanceCents)}</p>
        <p className="mt-1 text-sm text-muted">{t("minAmount", { min: money(readiness.minCents) })}</p>
        {heldCents > 0 ? (
          <p className="mt-1 text-sm text-muted">{t("heldNote", { held: money(heldCents), days: data.holdDays })}</p>
        ) : null}
        <Button
          block
          className="mt-4 sm:w-auto"
          disabled={hasOpenRequest || belowMin}
          onClick={() => setSheetOpen(true)}
        >
          <Banknote className="h-4 w-4" aria-hidden />
          {t("withdrawCta")}
        </Button>
        {hasOpenRequest ? (
          <p className="mt-2 text-sm text-muted">{t("openRequestNote")}</p>
        ) : belowMin ? (
          <p className="mt-2 text-sm text-muted">{t("belowMinNote", { min: money(readiness.minCents) })}</p>
        ) : null}
      </Card>

      <Card variant="muted">
        <div className="flex gap-3">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-info" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-fg">
              {readiness.method === "stripe" ? t("methodStripeTitle") : t("methodBankTitle")}
            </p>
            <p className="mt-1 text-sm text-muted">{methodBody}</p>
          </div>
        </div>
      </Card>

      {readiness.connectAvailable ? <ConnectSection accountReady={readiness.connectAccountReady} /> : null}

      <PayoutHistory payouts={data.payouts} />

      <WithdrawSheet open={sheetOpen} onOpenChange={setSheetOpen} data={data} onRequested={reload} />
    </div>
  );
}
