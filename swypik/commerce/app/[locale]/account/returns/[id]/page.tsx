/**
 * Return detail page with timeline.
 * /account/returns/[id]
 *
 * Reads return state and event history from commerce_orders.metadata
 * (return_status, return_history JSONB array, return_evidence_urls).
 */

import { Link } from "@/lib/i18n/navigation";
import { redirect, notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, Circle, Truck, PackageCheck, RotateCcw, XCircle, DollarSign } from "lucide-react";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

type OrderRow = {
  id: string;
  status: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

type TimelineEvent = {
  type: string;
  at: string;
  reason?: string;
  note?: string;
  by?: string;
};

function buildStages(t: (k: string) => string): Array<{ key: string; label: string; icon: typeof Circle }> {
  return [
    { key: "requested", label: t("stageRequested"), icon: RotateCcw },
    { key: "accepted", label: t("stageAccepted"), icon: CheckCircle2 },
    { key: "shipped_back", label: t("stageShippedBack"), icon: Truck },
    { key: "received", label: t("stageReceived"), icon: PackageCheck },
    { key: "refunded", label: t("stageRefunded"), icon: DollarSign },
  ];
}

const STAGE_INDEX: Record<string, number> = {
  requested: 0,
  accepted: 1,
  approved: 1,
  shipped_back: 2,
  received: 3,
  refunded: 4,
};

function buildTypeLabel(t: (k: string) => string): Record<string, string> {
  return {
    requested: t("typeRequested"),
    accepted: t("typeAccepted"),
    approved: t("typeAccepted"),
    rejected: t("typeRejected"),
    shipped_back: t("typeShippedBack"),
    received: t("typeReceived"),
    refunded: t("typeRefunded"),
  };
}

export default async function ReturnDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await getTranslations("accountReturns");
  const { id } = await params;
  const user = await getAuthUser();
  if (!user.userId) redirect(`/auth?next=/account/returns/${id}`);

  const { rows } = await dbQuery<OrderRow>(
    `SELECT id, status, created_at, metadata
       FROM commerce_orders
      WHERE id = $1::uuid AND buyer_user_id = $2
      LIMIT 1`,
    [id, user.userId]
  );
  const order = rows[0];
  if (!order) notFound();

  const meta: Record<string, unknown> = order.metadata || {};
  const reason: string | null = (meta.return_reason as string | undefined) || null;
  const status: string = (meta.return_status as string | undefined) || "requested";
  const evidenceUrls: string[] = Array.isArray(meta.return_evidence_urls)
    ? meta.return_evidence_urls.filter((u: unknown) => typeof u === "string")
    : [];
  const history: TimelineEvent[] = Array.isArray(meta.return_history)
    ? meta.return_history
    : [];

  // Synthesize a baseline event when no history (older returns).
  const events: TimelineEvent[] =
    history.length > 0
      ? history
      : reason
      ? [{ type: "requested", at: (meta.return_requested_at as string | undefined) || order.created_at, reason }]
      : [];

  const STAGES = buildStages(t);
  const TYPE_LABEL = buildTypeLabel(t);
  const rejected = status === "rejected" || events.some((e) => e.type === "rejected");
  const currentStage = rejected ? -1 : (STAGE_INDEX[status] ?? 0);

  return (
    <main className="min-h-screen bg-black pb-24 text-white">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-white/10 bg-black/90 px-4 py-3 backdrop-blur">
        <Link href="/account/returns" className="-ml-1 p-1 text-white/70 hover:text-white">
          <ArrowLeft size={22} />
        </Link>
        <h1 className="text-base font-black">{t("returTitle", { id: order.id.slice(0, 8) })}</h1>
      </header>

      <div className="mx-auto max-w-2xl space-y-5 px-4 py-6">
        {/* Stage progress */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
          <h2 className="text-sm font-bold text-white/80">{t("status")}</h2>
          {rejected ? (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-semibold text-red-300">
              <XCircle size={16} />  {t("cerereRespinsa")}
            </div>
          ) : (
            <ol className="mt-4 space-y-3">
              {STAGES.map((stage, i) => {
                const reached = i <= currentStage;
                const Icon = reached ? stage.icon : Circle;
                return (
                  <li key={stage.key} className="flex items-center gap-3">
                    <span
                      className={`flex h-7 w-7 items-center justify-center rounded-full ${
                        reached
                          ? "bg-emerald-500/20 text-emerald-300"
                          : "bg-white/5 text-white/30"
                      }`}
                    >
                      <Icon size={14} />
                    </span>
                    <span className={`text-sm ${reached ? "font-semibold text-white" : "text-white/40"}`}>
                      {stage.label}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {/* Reason */}
        {reason && (
          <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
            <h2 className="text-sm font-bold text-white/80">{t("motivulTau")}</h2>
            <p className="mt-2 text-sm text-white/70 whitespace-pre-line">{reason}</p>
          </section>
        )}

        {/* Evidence photos */}
        {evidenceUrls.length > 0 && (
          <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
            <h2 className="text-sm font-bold text-white/80">{t("fotografii")}</h2>
            <div className="mt-3 grid grid-cols-4 gap-2">
              {evidenceUrls.map((url, i) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block aspect-square overflow-hidden rounded-lg border border-white/10 bg-black/40"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={url} alt={t("evidenta", { i: i + 1 })} className="h-full w-full object-cover" />
                </a>
              ))}
            </div>
          </section>
        )}

        {/* Event timeline */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
          <h2 className="text-sm font-bold text-white/80">{t("istoric")}</h2>
          {events.length === 0 ? (
            <p className="mt-3 text-xs text-white/50">{t("nuExistaEvenimente")}</p>
          ) : (
            <ol className="relative mt-4 space-y-4 border-l border-white/10 pl-5">
              {[...events].reverse().map((ev, i) => (
                <li key={`${ev.type}-${ev.at}-${i}`} className="relative">
                  <span className="absolute -left-[1.6rem] top-1 h-2.5 w-2.5 rounded-full bg-white/40" />
                  <p className="text-sm font-semibold">{TYPE_LABEL[ev.type] || ev.type}</p>
                  <p className="text-xs text-white/40">
                    {new Date(ev.at).toLocaleString("ro-RO")}
                  </p>
                  {ev.note && <p className="mt-1 text-xs text-white/60">{ev.note}</p>}
                </li>
              ))}
            </ol>
          )}
        </section>

        <Link
          href={`/account/orders/${order.id}`}
          className="block rounded-xl border border-white/15 bg-white/[0.04] py-3 text-center text-sm font-semibold hover:bg-white/[0.08]"
        >
          
          {t("veziComanda")}
        </Link>
      </div>
    </main>
  );
}
