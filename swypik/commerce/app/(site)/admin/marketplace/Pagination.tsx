"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { PAGE_SIZE } from "./types";

interface Props {
  currentPage: number;
  totalPages: number;
  totalFiltered: number;
  startIdx: number;
  onPageChange: (n: number) => void;
}

export function Pagination({ currentPage, totalPages, totalFiltered, startIdx, onPageChange }: Props) {
  const t = useTranslations("adminMarketplace");
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-t border-slate-200 bg-slate-50/60 px-4 sm:px-6 py-4">
      <div className="text-sm text-slate-500 tabular-nums">
        {t("showingRange", {
          from: startIdx + 1,
          to: Math.min(startIdx + PAGE_SIZE, totalFiltered),
          total: totalFiltered,
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          disabled={currentPage <= 1}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          <ChevronLeft className="w-4 h-4" />
          <span className="hidden sm:inline">{t("previousPage")}</span>
        </button>

        <div className="flex items-center gap-1">
          {generatePageNumbers(currentPage, totalPages).map((pageNum, i) =>
            pageNum === "..." ? (
              <span key={`dots-${i}`} className="px-1 text-slate-400">
                …
              </span>
            ) : (
              <button
                key={pageNum}
                onClick={() => onPageChange(pageNum as number)}
                className={`min-w-[40px] h-10 rounded-lg px-2 text-sm font-bold transition-all ${
                  pageNum === currentPage
                    ? "bg-slate-900 text-white shadow-sm"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {pageNum}
              </button>
            )
          )}
        </div>

        <button
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
          disabled={currentPage >= totalPages}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          <span className="hidden sm:inline">{t("nextPage")}</span>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function generatePageNumbers(current: number, total: number): (number | "...")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages: (number | "...")[] = [];
  pages.push(1);
  if (current > 3) pages.push("...");

  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  for (let i = start; i <= end; i++) pages.push(i);

  if (current < total - 2) pages.push("...");
  pages.push(total);

  return pages;
}
