"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { FileSpreadsheet, Plus } from "lucide-react";

import { MarketplaceFilters } from "./MarketplaceFilters";
import { Pagination } from "./Pagination";
import { ProductTable } from "./ProductTable";
import { SummaryCards } from "./SummaryCards";
import { PAGE_SIZE, type Product, type ServerTotals, type SortDir, type SortField } from "./types";

export default function MarketplaceAdminPage() {
  const t = useTranslations("adminMarketplace");
  const [pageProducts, setPageProducts] = useState<Product[]>([]);
  const [serverTotals, setServerTotals] = useState<ServerTotals>({ total: 0, active: 0, with_image: 0, with_video: 0 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");

  const [sortField, setSortField] = useState<SortField>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const [currentPage, setCurrentPage] = useState(1);

  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => {
    const offset = (currentPage - 1) * PAGE_SIZE;
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
      status: statusFilter,
      source: sourceFilter,
      sort: sortField,
      dir: sortDir,
    });
    if (debouncedSearch) params.set("search", debouncedSearch);

    setLoading(true);
    fetch(`/api/admin/marketplace?${params.toString()}`, { credentials: "same-origin" })
      .then((res) => {
        if (!res.ok) throw new Error(t("loadError"));
        return res.json();
      })
      .then((data) => {
        setPageProducts(data.products ?? []);
        setServerTotals(data.totals ?? { total: 0, active: 0, with_image: 0, with_video: 0 });
        setLoadError(null);
      })
      .catch((error) => {
        setPageProducts([]);
        setLoadError(error instanceof Error ? error.message : t("loadError"));
      })
      .finally(() => setLoading(false));
  }, [debouncedSearch, statusFilter, sourceFilter, sortField, sortDir, currentPage, t]);

  const handleSearchChange = useCallback((v: string) => {
    setSearchQuery(v);
    setCurrentPage(1);
  }, []);
  const handleStatusChange = useCallback((v: string) => {
    setStatusFilter(v);
    setCurrentPage(1);
  }, []);
  const handleSourceChange = useCallback((v: string) => {
    setSourceFilter(v);
    setCurrentPage(1);
  }, []);

  const toggleSort = useCallback(
    (field: SortField) => {
      if (sortField === field) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortField(field);
        setSortDir(field === "date" ? "desc" : "asc");
      }
      setCurrentPage(1);
    },
    [sortField],
  );

  const totalFiltered = serverTotals.total;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const startIdx = (safePage - 1) * PAGE_SIZE;
  const hasFiltersActive = Boolean(debouncedSearch) || statusFilter !== "all" || sourceFilter !== "all";

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-6 md:space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-black text-slate-900">{t("pageTitle")}</h1>
          <p className="mt-2 text-slate-500">
            {t("pageSubtitle")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/admin/marketplace/import"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 hover:bg-slate-50 transition-colors"
          >
            <FileSpreadsheet className="w-4 h-4" />
            {t("importCsv")}
          </Link>
          <Link
            href="/admin/marketplace/new"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-bold text-white hover:bg-slate-800 transition-colors"
          >
            <Plus className="w-4 h-4" />
            {t("newProduct")}
          </Link>
        </div>
      </div>

      <SummaryCards totals={serverTotals} loading={loading} />

      {loadError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {loadError}
        </div>
      ) : null}

      <MarketplaceFilters
        searchQuery={searchQuery}
        statusFilter={statusFilter}
        sourceFilter={sourceFilter}
        totalFiltered={totalFiltered}
        onSearchChange={handleSearchChange}
        onStatusChange={handleStatusChange}
        onSourceChange={handleSourceChange}
      />

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <ProductTable
          products={pageProducts}
          loading={loading}
          totalProducts={serverTotals.total}
          hasFiltersActive={hasFiltersActive}
          sortField={sortField}
          sortDir={sortDir}
          onToggleSort={toggleSort}
        />

        {!loading && totalFiltered > 0 && (
          <Pagination
            currentPage={safePage}
            totalPages={totalPages}
            totalFiltered={totalFiltered}
            startIdx={startIdx}
            onPageChange={setCurrentPage}
          />
        )}
      </div>
    </div>
  );
}
