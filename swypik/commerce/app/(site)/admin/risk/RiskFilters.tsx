import Link from "next/link";
import { getTranslations } from "next-intl/server";

export async function RiskFilters({
  statusFilter,
  minScore,
}: {
  statusFilter: string;
  minScore: number;
}) {
  const t = await getTranslations("adminRisk");
  const statuses = [
    { k: "paid", label: t("statusPaid") },
    { k: "pending", label: t("statusPending") },
    { k: "fulfilled", label: t("statusFulfilled") },
    { k: "all", label: t("statusAll") },
  ];
  const mins = [0, 30, 50, 70];
  return (
    <div className="flex flex-col md:flex-row gap-2 text-xs md:items-center">
      <div className="flex gap-1.5 flex-wrap">
        {statuses.map((f) => (
          <Link
            key={f.k}
            href={`/admin/risk?status=${f.k}${minScore > 0 ? `&min=${minScore}` : ""}`}
            className={`px-3 py-1.5 rounded font-medium ${
              statusFilter === f.k
                ? "bg-violet-600 text-white"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>
      <div className="flex gap-1 items-center flex-wrap md:ml-auto">
        <span className="text-gray-500 mr-1">{t("minScoreLabel")}:</span>
        {mins.map((m) => (
          <Link
            key={m}
            href={`/admin/risk?status=${statusFilter}&min=${m}`}
            className={`px-2 py-1 rounded ${
              minScore === m ? "bg-violet-100 text-violet-800 font-semibold" : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            &ge;{m}
          </Link>
        ))}
      </div>
    </div>
  );
}
