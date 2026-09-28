"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Banknote, Info } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { useToast } from "@/components/ui/Toast";
import { PayoutCard } from "./PayoutCard";
import { ResolvePayoutDialog } from "./ResolvePayoutDialog";
import { PAYOUT_STATUSES, errorKey, type CreatorPayoutRow, type PayoutAction } from "./shared";

const FILTERS = [...PAYOUT_STATUSES, "all"] as const;
type Filter = (typeof FILTERS)[number];

type AdminProps = {
  /** API-ul cozii (creator implicit; sellerii: /api/admin/seller-payouts). */
  endpoint?: string;
  /** Namespace i18n cu aceleași chei ca adminCreatorPayouts. */
  ns?: string;
};

/** Admin — coada cererilor de retragere (creatori sau selleri, aceeași formă de rând). */
export function CreatorPayoutsAdmin({ endpoint = "/api/admin/creator-payouts", ns = "adminCreatorPayouts" }: AdminProps = {}) {
  const t = useTranslations(ns);
  const { toast } = useToast();
  const [filter, setFilter] = useState<Filter>("pending");
  const [rows, setRows] = useState<CreatorPayoutRow[] | null>(null);
  const [connectAvailable, setConnectAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<{ payout: CreatorPayoutRow; action: PayoutAction } | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(
    async (keep = false) => {
      if (!keep) setRows(null);
      setError(null);
      try {
        const qs = filter === "all" ? "" : `?status=${filter}`;
        const res = await fetch(`${endpoint}${qs}`, { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as {
          payouts?: CreatorPayoutRow[];
          connectAvailable?: boolean;
          error?: string;
        };
        if (!res.ok) throw new Error(data.error ?? "generic");
        setRows(data.payouts ?? []);
        setConnectAvailable(data.connectAvailable === true);
      } catch (e) {
        setError(t(errorKey(e instanceof Error ? e.message : null)));
      }
    },
    [filter, t, endpoint],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(note: string) {
    if (!target || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: target.payout.id, action: target.action, note: note || null }),
      });
      const data = (await res.json().catch(() => ({}))) as { via?: "stripe" | "bank" | null; error?: string };
      if (!res.ok) throw new Error(data.error ?? "generic");
      toast({
        title:
          target.action === "rejected"
            ? t("toast.rejected")
            : data.via === "stripe"
              ? t("toast.paidStripe")
              : t("toast.paidBank"),
        tone: "success",
      });
      setTarget(null);
      await load(true);
    } catch (e) {
      const code = e instanceof Error ? e.message : null;
      setActionError(t(errorKey(code)));
      // transfer_failed: cererea revine în „pending” cu motivul eșecului — reîmprospătează.
      if (code === "transfer_failed" || code === "not_pending") void load(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader title={t("title")} subtitle={t("subtitle")} menu={false}>
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList aria-label={t("filterLabel")}>
            {FILTERS.map((f) => (
              <TabsTrigger key={f} value={f}>
                {t(`filter.${f}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </PageHeader>

      <div className="mx-auto max-w-5xl space-y-3 px-gutter py-4">
        <p className="flex items-start gap-2 rounded-card bg-info-soft px-3 py-2 text-sm text-info">
          <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{connectAvailable ? t("howConnect") : t("howBank")}</span>
        </p>

        {error ? (
          <ErrorState description={error} onRetry={() => void load()} />
        ) : rows === null ? (
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-40 w-full rounded-card" />)
        ) : rows.length === 0 ? (
          <EmptyState icon={Banknote} title={t("empty")} description={t("emptyHint")} />
        ) : (
          <ul className="space-y-3">
            {rows.map((p) => (
              <li key={p.id}>
                <PayoutCard
                  ns={ns}
                  payout={p}
                  connectAvailable={connectAvailable}
                  onAction={(action) => {
                    setActionError(null);
                    setTarget({ payout: p, action });
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <ResolvePayoutDialog
        ns={ns}
        target={target}
        connectAvailable={connectAvailable}
        busy={busy}
        error={actionError}
        onCancel={() => setTarget(null)}
        onConfirm={(note) => void resolve(note)}
      />
    </div>
  );
}
