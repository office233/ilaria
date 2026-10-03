import Link from "next/link";
import { Ban, Lightbulb } from "lucide-react";
import { getTranslations, getLocale } from "next-intl/server";
import type { OrderRiskScore } from "@/lib/risk/order-fraud-score";
import { FraudActions } from "./FraudActions";

type OrderMetadata = {
  shipping_address?: { line1?: string; address_line_1?: string; country?: string };
  billing_address?: { country?: string };
  items?: unknown[];
  item_count?: number;
  checkout_ip_country?: string;
  fraud_block?: boolean;
  fraud_last_decision?: { action: string; at: string; reason?: string };
};

export type OrderRow = {
  id: string;
  status: string;
  buyer_user_id: string | null;
  currency: string;
  total_cents: number;
  created_at: string;
  metadata: OrderMetadata | null;
  buyer_email: string | null;
  buyer_phone: string | null;
  buyer_email_verified_at: string | null;
  buyer_phone_verified_at: string | null;
  buyer_created_at: string | null;
  prior_paid: number;
  prior_disputes: number;
  prior_chargebacks_lost: number;
};

function levelBadge(level: OrderRiskScore["level"], t: Awaited<ReturnType<typeof getTranslations>>) {
  switch (level) {
    case "critical": return { bg: "bg-red-600", text: "text-white", label: t("levelCritical") };
    case "high": return { bg: "bg-orange-500", text: "text-white", label: t("levelHigh") };
    case "medium": return { bg: "bg-amber-100", text: "text-amber-900", label: t("levelMedium") };
    case "low": return { bg: "bg-emerald-100", text: "text-emerald-900", label: t("levelLow") };
  }
}

function fmtMoney(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

export async function OrderRiskCard({ row, risk }: { row: OrderRow; risk: OrderRiskScore }) {
  const t = await getTranslations("adminRisk");
  const locale = await getLocale();
  const badge = levelBadge(risk.level, t);
  const positives = risk.factors.filter((f) => f.delta > 0);
  const negatives = risk.factors.filter((f) => f.delta < 0);
  const dateFmt = (d: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(d));

  return (
    <details className="bg-white border border-[#E5E5E5] rounded p-3 group">
      <summary className="flex items-center justify-between gap-3 cursor-pointer list-none">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <span
            className={`shrink-0 ${badge.bg} ${badge.text} font-bold text-xs px-2.5 py-1 rounded`}
            title={risk.recommendation}
          >
            {risk.score}
          </span>
          <span
            className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${badge.bg} ${badge.text} opacity-80`}
          >
            {badge.label}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[#0D0D0D] truncate">
              {row.buyer_email || t("guest")}{" "}
              <span className="text-xs text-gray-500 font-normal">
                &middot; {fmtMoney(row.total_cents, row.currency)} &middot; {row.status}
              </span>
            </div>
            <div className="text-xs text-gray-500 truncate">
              {t("orderLabel")} <code className="font-mono">{row.id.slice(0, 8)}</code> &middot;{" "}
              {dateFmt(row.created_at)}
              {row.prior_paid > 0 && ` · ${t("priorOrders", { count: row.prior_paid })}`}
              {row.prior_disputes > 0 && ` · ${t("priorDisputes", { count: row.prior_disputes })}`}
            </div>
          </div>
        </div>
        {risk.blockSuggested && (
          <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold bg-red-100 text-red-800 px-1.5 py-0.5 rounded">
            <Ban size={10} /> {t("blockSuggested")}
          </span>
        )}
      </summary>

      <div className="mt-3 pt-3 border-t border-[#E5E5E5] space-y-3">
        <div className="text-xs bg-violet-50 text-violet-900 px-2 py-1.5 rounded flex items-center gap-1">
          <Lightbulb size={12} className="shrink-0" /> {risk.recommendation}
        </div>

        {positives.length > 0 && (
          <FactorList title={t("negativeSignals", { count: positives.length })} factors={positives} tone="red" />
        )}
        {negatives.length > 0 && (
          <FactorList title={t("positiveSignals", { count: negatives.length })} factors={negatives} tone="emerald" />
        )}

        {row.metadata?.fraud_last_decision && (
          <div className="text-xs bg-blue-50 text-blue-900 px-2 py-1.5 rounded">
            <span className="font-semibold">{t("lastDecision")}:</span>{" "}
            <span className="font-mono">{row.metadata.fraud_last_decision.action}</span> {t("atTime")}{" "}
            {dateFmt(row.metadata.fraud_last_decision.at)}
            {row.metadata.fraud_last_decision.reason && (
              <>
                {" — "}
                <em>{row.metadata.fraud_last_decision.reason}</em>
              </>
            )}
          </div>
        )}

        <div className="flex gap-2 pt-1 items-center flex-wrap">
          <Link
            href={`/admin/orders/${row.id}`}
            className="text-xs px-2.5 py-1 rounded bg-violet-100 text-violet-800 hover:bg-violet-200 font-semibold"
          >
            {t("viewOrder")} &rarr;
          </Link>
          <FraudActions orderId={row.id} blocked={row.metadata?.fraud_block === true} />
        </div>
      </div>
    </details>
  );
}

function FactorList({
  title,
  factors,
  tone,
}: {
  title: string;
  factors: OrderRiskScore["factors"];
  tone: "red" | "emerald";
}) {
  const titleCls = tone === "red" ? "text-red-700" : "text-emerald-700";
  const itemBg = tone === "red" ? "bg-red-50" : "bg-emerald-50";
  const itemFg = tone === "red" ? "text-red-700" : "text-emerald-700";
  return (
    <div>
      <div className={`text-xs font-semibold ${titleCls} mb-1`}>{title}</div>
      <ul className="space-y-0.5 text-xs">
        {factors.map((f, i) => (
          <li key={i} className={`flex justify-between gap-2 ${itemBg} px-2 py-0.5 rounded`}>
            <span className="text-gray-800">{f.note}</span>
            <span className={`${itemFg} font-mono font-bold`}>
              {f.delta > 0 ? `+${f.delta}` : f.delta}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
