/**
 * Server component: „De rezolvat” — cozile operaționale cu link direct.
 * Un singur query agregat; eroarea ascunde secțiunea (dashboard-ul rămâne).
 */
import { getTranslations } from "next-intl/server";
import { AlertTriangle, CheckCircle2, Coins, Inbox, RotateCcw, Shield, ShieldAlert } from "lucide-react";
import { dbQuery } from "@/lib/db";
import { KpiCard, type KpiTone } from "@/components/admin/KpiCard";

type Counts = {
  disputes_pending: number;
  disputes_urgent: number;
  returns_pending: number;
  refunds_pending: number;
  stale_pending_orders: number;
  risky_orders_7d: number;
  partner_apps_pending: number;
};

/** Praguri peste care o coadă devine roșie (în rest: galben dacă > 0). */
const DANGER_AT = { applications: 5, returns: 10, risk: 3 } as const;

async function getCounts(): Promise<Counts> {
  const { rows } = await dbQuery<Record<keyof Counts, string>>(`
    SELECT
      (SELECT COUNT(*) FROM stripe_disputes
        WHERE status IN ('needs_response','warning_needs_response')
          AND evidence_submitted = false) AS disputes_pending,
      (SELECT COUNT(*) FROM stripe_disputes
        WHERE status IN ('needs_response','warning_needs_response')
          AND evidence_submitted = false
          AND evidence_due_by < now() + interval '24 hours') AS disputes_urgent,
      (SELECT COUNT(*) FROM commerce_orders
        WHERE status = 'return_requested'
           OR (metadata->>'return_status') = 'requested') AS returns_pending,
      (SELECT COUNT(*) FROM payment_transactions
        WHERE transaction_type = 'refund'
          AND status IN ('pending','processing','requires_action')) AS refunds_pending,
      (SELECT COUNT(*) FROM commerce_orders
        WHERE status IN ('pending_payment','pending')
          AND created_at < now() - interval '24 hours') AS stale_pending_orders,
      (SELECT COUNT(*) FROM commerce_orders co
        LEFT JOIN users u ON u.id = co.buyer_user_id
        WHERE co.created_at > now() - interval '7 days'
          AND co.status = 'paid'
          AND (
            co.buyer_user_id IS NULL
            OR u.email_verified_at IS NULL
            OR co.total_cents > 200000
            OR (u.created_at IS NOT NULL AND u.created_at > now() - interval '7 days')
          )) AS risky_orders_7d,
      (
        COALESCE((SELECT COUNT(*) FROM couriers WHERE verification_status = 'pending'), 0)
        + COALESCE((SELECT COUNT(*) FROM fleet_partners WHERE status = 'pending'), 0)
        + COALESCE((SELECT COUNT(*) FROM sellers WHERE status = 'pending'), 0)
        + COALESCE((SELECT COUNT(*) FROM host_applications WHERE status IN ('pending','needs_info')), 0)
        + COALESCE((SELECT COUNT(*) FROM creator_applications WHERE status IN ('submitted','in_review')), 0)
        + COALESCE((SELECT COUNT(*) FROM local_merchants
                     WHERE status = 'pending' AND COALESCE(source, 'manual') <> 'osm'), 0)
      ) AS partner_apps_pending
  `);
  const r = rows[0] ?? ({} as Partial<Record<keyof Counts, string>>);
  const n = (k: keyof Counts) => Number(r[k] ?? 0);
  return {
    disputes_pending: n("disputes_pending"),
    disputes_urgent: n("disputes_urgent"),
    returns_pending: n("returns_pending"),
    refunds_pending: n("refunds_pending"),
    stale_pending_orders: n("stale_pending_orders"),
    risky_orders_7d: n("risky_orders_7d"),
    partner_apps_pending: n("partner_apps_pending"),
  };
}

function tone(count: number, dangerAt?: number): KpiTone {
  if (count === 0) return "neutral";
  return dangerAt !== undefined && count > dangerAt ? "danger" : "warning";
}

export default async function OpsAlertsBar() {
  const t = await getTranslations("adminShell.opsAlerts");
  let c: Counts;
  try {
    c = await getCounts();
  } catch {
    return null;
  }

  const cards = [
    { href: "/admin/aplicatii?f=pending", label: t("applications"), count: c.partner_apps_pending, Icon: Inbox, tone: tone(c.partner_apps_pending, DANGER_AT.applications) },
    {
      href: "/admin/disputes?status=needs_response",
      label: t("disputes"),
      count: c.disputes_pending,
      Icon: Shield,
      hint: c.disputes_urgent > 0 ? t("urgentBadge", { count: c.disputes_urgent }) : undefined,
      tone: c.disputes_urgent > 0 ? ("danger" as const) : tone(c.disputes_pending),
    },
    { href: "/admin/returns?status=requested", label: t("returns"), count: c.returns_pending, Icon: RotateCcw, tone: tone(c.returns_pending, DANGER_AT.returns) },
    { href: "/admin/refunds", label: t("refunds"), count: c.refunds_pending, Icon: Coins, tone: tone(c.refunds_pending) },
    { href: "/admin/orders?status=pending_payment", label: t("pendingOver24h"), count: c.stale_pending_orders, Icon: AlertTriangle, tone: tone(c.stale_pending_orders) },
    { href: "/admin/risk?status=paid&min=50", label: t("fraudRisk"), count: c.risky_orders_7d, Icon: ShieldAlert, tone: tone(c.risky_orders_7d, DANGER_AT.risk) },
  ];

  const open = cards.filter((card) => card.count > 0);
  return (
    <section className="space-y-2" aria-label={t("title")}>
      <h2 className="text-sm font-semibold text-muted">{t("title")}</h2>
      {open.length === 0 ? (
        <p className="flex items-center gap-2 rounded-card bg-success-soft p-3 text-sm text-success">
          <CheckCircle2 className="h-4 w-4" aria-hidden /> {t("allClear")}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {open.map((card) => (
            <KpiCard
              key={card.href}
              href={card.href}
              label={card.label}
              value={String(card.count)}
              hint={card.hint}
              icon={card.Icon}
              tone={card.tone}
            />
          ))}
        </div>
      )}
    </section>
  );
}
