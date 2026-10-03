"use client";

import { Filter, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { SOURCE_OPTIONS, STATUS_OPTIONS } from "./types";

const SELECT_BG_STYLE = {
  backgroundImage:
    'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 12 12\'%3E%3Cpath fill=\'%2394a3b8\' d=\'M6 8.825a.5.5 0 01-.354-.146l-3-3a.5.5 0 11.708-.708L6 7.621l2.646-2.647a.5.5 0 11.708.708l-3 3A.5.5 0 016 8.825z\'/%3E%3C/svg%3E")',
  backgroundRepeat: "no-repeat" as const,
  backgroundPosition: "right 12px center",
  paddingRight: "36px",
};

interface Props {
  searchQuery: string;
  statusFilter: string;
  sourceFilter: string;
  totalFiltered: number;
  onSearchChange: (v: string) => void;
  onStatusChange: (v: string) => void;
  onSourceChange: (v: string) => void;
}

export function MarketplaceFilters({
  searchQuery,
  statusFilter,
  sourceFilter,
  totalFiltered,
  onSearchChange,
  onStatusChange,
  onSourceChange,
}: Props) {
    const t = useTranslations("adminMarketplace");
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400 pointer-events-none" />
        <input
          id="marketplace-search"
          type="text"
          placeholder={t("searchPlaceholder")}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 py-3 pl-12 pr-4 text-sm text-slate-900 placeholder:text-slate-400 focus:border-orange-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-100 transition-all"
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 text-xs font-bold text-slate-500 uppercase tracking-wider">
          <Filter className="w-4 h-4" />
          {t("filters")}
        </div>

        <div className="flex-1 sm:max-w-[200px]">
          <select
            id="filter-status"
            value={statusFilter}
            onChange={(e) => onStatusChange(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100 transition-all cursor-pointer appearance-none"
            style={SELECT_BG_STYLE}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t("statusPrefix")} {t(o.labelKey)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1 sm:max-w-[220px]">
          <select
            id="filter-source"
            value={sourceFilter}
            onChange={(e) => onSourceChange(e.target.value)}
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-100 transition-all cursor-pointer appearance-none"
            style={SELECT_BG_STYLE}
          >
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t("sourcePrefix")} {t(o.labelKey)}
              </option>
            ))}
          </select>
        </div>

        <div className="ml-auto text-sm text-slate-500 tabular-nums">
          {t("productsFound", { count: totalFiltered })}
        </div>
      </div>
    </div>
  );
}
