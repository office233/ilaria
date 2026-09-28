"use client";

/**
 * Dispecerat Food: comenzile active (blocate primele) + anulare cu refund,
 * reatribuire curier, marcare livrată (POST /api/admin/food/orders/[id], auditat).
 * Audit food-go #7: comenzile rămâneau blocate în 'ready' / 'picked_up'.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { goFetch, useGoFormat } from "@/components/go/format";
import type { AdminFoodOrder } from "@/lib/food/admin-ops";
import { ADMIN_POLL_MS, useAdminResource } from "./useAdminApi";

const REASSIGNABLE = new Set(["accepted", "preparing", "ready"]);
const DELIVERABLE = new Set(["picked_up", "delivering"]);

export default function FoodOrdersTab() {
  const t = useTranslations("adminGo");
  const tStatus = useTranslations("foodMerchant");
  const f = useGoFormat();
  const { toast } = useToast();
  const { data, error, reload } = useAdminResource<{ orders: AdminFoodOrder[] }>("/api/admin/food/orders", ADMIN_POLL_MS);
  const [cancelling, setCancelling] = useState<AdminFoodOrder | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (id: string, body: Record<string, unknown>) => {
    setBusy(`${id}:${String(body.action)}`);
    const r = await goFetch(`/api/admin/food/orders/${id}`, { method: "POST", body: JSON.stringify(body) });
    setBusy(null);
    toast({ title: r.ok ? t("done") : t("saveError"), tone: r.ok ? "success" : "danger" });
    void reload();
    return r.ok;
  };

  if (error && !data) return <ErrorState description={t("loadError")} onRetry={() => void reload()} />;
  if (!data) return <Skeleton className="h-64 w-full" />;
  if (!data.orders.length) return <EmptyState title={t("food.empty")} />;

  return (
    <div className="space-y-2">
      {data.orders.map((o) => (
        <Card key={o.id} padding="sm" className="flex flex-wrap items-center gap-3">
          <Badge tone={o.stuck ? "danger" : o.status === "placed" ? "warning" : "info"}>{tStatus(`status.${o.status}`)}</Badge>
          {o.stuck ? <Badge tone="danger">{t("food.stuck")}</Badge> : null}
          <div className="min-w-0 flex-1 text-sm">
            <p className="truncate text-fg">
              {o.order_number} · {o.merchant_name} · {f.money(o.total_cents, o.currency)}
            </p>
            <p className="text-xs text-muted">
              {f.time(o.placed_at)} · {o.payment_method}/{o.payment_status} · {o.courier_name ?? t("food.noCourier")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {REASSIGNABLE.has(o.status) ? (
              <Button size="sm" variant="secondary" loading={busy === `${o.id}:reassign`} onClick={() => void act(o.id, { action: "reassign" })}>
                {t("food.reassign")}
              </Button>
            ) : null}
            {DELIVERABLE.has(o.status) ? (
              <Button size="sm" variant="secondary" loading={busy === `${o.id}:delivered`} onClick={() => void act(o.id, { action: "delivered" })}>
                {t("food.delivered")}
              </Button>
            ) : null}
            <Button size="sm" variant="danger" onClick={() => setCancelling(o)}>
              {t("food.cancel")}
            </Button>
          </div>
        </Card>
      ))}

      <Dialog
        open={Boolean(cancelling)}
        onOpenChange={(open) => !open && setCancelling(null)}
        title={t("food.cancelTitle")}
        description={t("food.cancelBody")}
        footer={
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setCancelling(null)}>
              {t("food.keep")}
            </Button>
            <Button
              variant="danger"
              loading={Boolean(cancelling && busy === `${cancelling.id}:cancel`)}
              onClick={async () => {
                if (!cancelling) return;
                if (await act(cancelling.id, { action: "cancel", reason: reason.trim() || undefined })) {
                  setCancelling(null);
                  setReason("");
                }
              }}
            >
              {t("food.cancel")}
            </Button>
          </div>
        }
      >
        <Input aria-label={t("cancelReason")} placeholder={t("cancelReason")} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
      </Dialog>
    </div>
  );
}
