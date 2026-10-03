import { getTranslations } from "next-intl/server";

type Summary = { critical: number; high: number; medium: number; low: number };

export async function SummaryCards({ summary }: { summary: Summary }) {
  const t = await getTranslations("adminRisk");
  const cards = [
    { label: t("levelCritical"), value: summary.critical, bg: "bg-red-50", border: "border-red-200", text: "text-red-700", val: "text-red-900" },
    { label: t("levelHigh"), value: summary.high, bg: "bg-orange-50", border: "border-orange-200", text: "text-orange-700", val: "text-orange-900" },
    { label: t("levelMedium"), value: summary.medium, bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-700", val: "text-amber-900" },
    { label: t("levelLow"), value: summary.low, bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-700", val: "text-emerald-900" },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
      {cards.map((c) => (
        <div key={c.label} className={`${c.bg} border ${c.border} rounded p-2.5 flex items-center justify-between gap-2`}>
          <div className={`text-[11px] ${c.text} font-semibold uppercase tracking-wider`}>{c.label}</div>
          <div className={`text-xl font-bold ${c.val} tabular-nums`}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}
