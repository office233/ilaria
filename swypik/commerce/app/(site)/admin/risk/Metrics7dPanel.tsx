import { BarChart3, AlertTriangle, Info } from "lucide-react";
import { getTranslations } from "next-intl/server";

export type Metrics7d = {
  totalDecisions: number;
  approvals: number;
  blocks: number;
  autoBlocks: number;
  flaggedOrders: number;
  blockRate: number;
  approveRate: number;
};

export async function Metrics7dPanel({ metrics }: { metrics: Metrics7d }) {
  const t = await getTranslations("adminRisk");
  return (
    <div className="bg-white border border-[#E5E5E5] rounded p-3">
      <div className="text-xs font-semibold text-gray-700 mb-2 flex items-center gap-1"><BarChart3 size={14} /> {t("activityLast7Days")}</div>
      <div className="grid grid-cols-3 md:grid-cols-5 gap-3 text-center">
        <Stat label={t("flaggedOrders")} value={metrics.flaggedOrders} />
        <Stat
          label={t("approved")}
          value={metrics.approvals}
          pct={metrics.approveRate}
          tone="emerald"
        />
        <Stat
          label={t("blockedManual")}
          value={metrics.blocks}
          pct={metrics.blockRate}
          tone="red"
        />
        <Stat label={t("userAutoBlock")} value={metrics.autoBlocks} tone="orange" />
        <Stat label={t("totalDecisions")} value={metrics.totalDecisions} />
      </div>
      {metrics.blockRate > 60 && metrics.totalDecisions >= 5 && (
        <div className="mt-2 text-[11px] bg-red-50 text-red-800 px-2 py-1 rounded flex items-center gap-1">
          <AlertTriangle size={12} className="shrink-0" /> {t("highBlockRateWarning", { rate: metrics.blockRate })}
        </div>
      )}
      {metrics.approveRate > 80 && metrics.totalDecisions >= 5 && (
        <div className="mt-2 text-[11px] bg-amber-50 text-amber-800 px-2 py-1 rounded flex items-center gap-1">
          <Info size={12} className="shrink-0" /> {t("highApproveRateWarning", { rate: metrics.approveRate })}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  pct,
  tone,
}: {
  label: string;
  value: number;
  pct?: number;
  tone?: "emerald" | "red" | "orange";
}) {
  const text =
    tone === "emerald" ? "text-emerald-700"
      : tone === "red" ? "text-red-700"
        : tone === "orange" ? "text-orange-700"
          : "text-gray-900";
  return (
    <div>
      <div className={`text-[10px] uppercase tracking-wider ${tone ? text : "text-gray-500"}`}>
        {label}
      </div>
      <div className={`text-lg font-bold ${text}`}>
        {value}
        {pct !== undefined && (
          <span className="text-[10px] font-normal text-gray-500"> ({pct}%)</span>
        )}
      </div>
    </div>
  );
}
