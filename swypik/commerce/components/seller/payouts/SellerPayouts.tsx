"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Banknote, Info } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { useToast } from "@/components/ui/Toast";
import { PanelHeading } from "@/components/seller/PanelHeading";
import { sellerApi, sellerErrorKey } from "@/components/seller/api";
import { formatSellerDate, formatSellerMoney } from "@/components/seller/format";
import type { SellerBalance, SellerPayoutRequestView, SellerPayoutSetup } from "@/lib/seller/payouts";
import { RequestPayoutSheet } from "./RequestPayoutSheet";

type Setup = Omit<SellerPayoutSetup, "iban"> & { ibanMasked: string | null; hasIban: boolean };
type Data = { setup: Setup; balance: SellerBalance; requests: SellerPayoutRequestView[] };

const ERRORS = ["below_minimum", "iban_required", "open_request_exists", "invalid_iban", "rate_limited"] as const;
const TONE: Record<string, "warning" | "info" | "success" | "neutral" | "danger"> = {
  pending: "warning",
  processing: "info",
  paid: "success",
  rejected: "neutral",
  failed: "danger",
};

export function SellerPayouts() {
  const t = useTranslations("sellerPanel.payouts");
  const locale = useLocale();
  const { toast } = useToast();
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    const res = await sellerApi<Data>("/api/seller/payouts");
    if (res.ok) setData(res.data);
    else setLoadError(true);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (loadError) return <ErrorState onRetry={() => void load()} />;
  if (!data) return <Skeleton className="h-64 w-full rounded-card" />;

  const { setup, balance, requests } = data;
  const money = (c: number) => formatSellerMoney(locale, c, setup.currency);
  const hasOpen = requests.some((r) => r.status === "pending" || r.status === "processing");
  const canRequest = !hasOpen && balance.availableCents >= setup.minCents;

  async function submit(iban: string | null) {
    setBusy(true);
    setError(null);
    const res = await sellerApi<{ amountCents: number }>("/api/seller/payouts", { method: "POST", body: { iban } });
    setBusy(false);
    if (!res.ok) {
      setError(t(sellerErrorKey(res.error, ERRORS), { min: money(setup.minCents) }));
      return;
    }
    setSheet(false);
    toast({ title: t("requested", { amount: money(res.data.amountCents) }), tone: "success" });
    await load();
  }

  async function connectStripe() {
    setConnecting(true);
    const res = await sellerApi<{ url?: string }>("/api/seller/stripe-connect", { method: "POST" });
    setConnecting(false);
    if (res.ok && res.data.url) window.location.href = res.data.url;
    else toast({ title: t("errors.generic"), tone: "danger" });
  }

  return (
    <div className="space-y-4">
      <PanelHeading title={t("title")} subtitle={t("subtitle", { days: setup.windowDays })} />

      <Card>
        <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{t("available")}</p>
        <p className="mt-1 text-3xl font-bold text-fg">{money(balance.availableCents)}</p>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          {(
            [
              ["onHold", balance.onHoldCents],
              ["requestedSum", balance.requestedCents],
              ["paid90", balance.paid90Cents],
              ["paidTotal", balance.paidTotalCents],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-subtle">{t(k)}</dt>
              <dd className="font-semibold text-fg">{money(v)}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={() => { setError(null); setSheet(true); }} disabled={!canRequest}>
            {t("request")}
          </Button>
          {setup.connectAvailable && !setup.connectReady ? (
            <Button variant="secondary" loading={connecting} onClick={() => void connectStripe()}>
              {t("connectStripe")}
            </Button>
          ) : null}
        </div>
        <p className="mt-3 flex items-start gap-2 rounded-control bg-info-soft px-3 py-2 text-sm text-info">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {hasOpen
              ? t("hintOpen")
              : balance.availableCents < setup.minCents
                ? t("hintMin", { min: money(setup.minCents) })
                : setup.method === "stripe"
                  ? t("hintStripe")
                  : t("hintBank")}
          </span>
        </p>
      </Card>

      <section aria-labelledby="payout-history">
        <h2 id="payout-history" className="mb-2 text-lg font-semibold text-fg">{t("history")}</h2>
        {requests.length === 0 ? (
          <EmptyState icon={Banknote} title={t("emptyTitle")} description={t("emptyHint")} />
        ) : (
          <ul className="space-y-2">
            {requests.map((r) => (
              <li key={r.id}>
                <Card padding="sm" className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-fg">{money(r.amountCents)}</p>
                    <p className="text-xs text-muted">
                      {formatSellerDate(locale, r.requestedAt, true)}
                      {r.iban ? ` · ${r.iban}` : ""}
                    </p>
                    {r.adminNote ? <p className="mt-1 text-xs text-muted">{r.adminNote}</p> : null}
                  </div>
                  <Badge tone={TONE[r.status] ?? "neutral"}>{t(`status.${r.status in TONE ? r.status : "pending"}`)}</Badge>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <RequestPayoutSheet
        open={sheet}
        onOpenChange={setSheet}
        method={setup.method}
        amountLabel={money(balance.availableCents)}
        ibanMasked={setup.ibanMasked}
        busy={busy}
        error={error}
        onConfirm={(iban) => void submit(iban)}
      />
    </div>
  );
}
