"use client";

/** Încărcarea listei /api/merchants cu filtre, debounce la căutare și „încarcă mai mult”. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MerchantSummary } from "@/lib/food/types";
import type { FoodFilterState } from "./FoodFilters";
import type { GeoPoint } from "./useFoodLocation";

const SEARCH_DEBOUNCE_MS = 300;

type State = { items: MerchantSummary[]; loading: boolean; error: boolean; hasMore: boolean; page: number };

export function useMerchantList(args: { filters: FoodFilterState; city: string | null; geo: GeoPoint | null; enabled: boolean }) {
  const { filters, city, geo, enabled } = args;
  const [state, setState] = useState<State>({ items: [], loading: true, error: false, hasMore: false, page: 1 });
  const [q, setQ] = useState(filters.q);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setQ(filters.q.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [filters.q]);

  const load = useCallback(
    async (page: number) => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      setState((s) => ({ ...s, loading: true, error: false }));
      const qs = new URLSearchParams({ kind: "restaurant", sort: filters.sort, page: String(page) });
      if (geo) {
        qs.set("lat", String(geo.lat));
        qs.set("lng", String(geo.lng));
      } else if (city) qs.set("city", city);
      if (filters.cuisine) qs.set("cuisine", filters.cuisine);
      if (filters.openNow) qs.set("open", "1");
      if (q) qs.set("q", q);
      try {
        const res = await fetch(`/api/merchants?${qs}`, { signal: ctrl.signal });
        const data = (await res.json().catch(() => null)) as { success?: boolean; merchants?: MerchantSummary[]; has_more?: boolean } | null;
        if (!res.ok || !data?.success) throw new Error("load_failed");
        setState((s) => ({
          items: page === 1 ? data.merchants ?? [] : [...s.items, ...(data.merchants ?? [])],
          loading: false,
          error: false,
          hasMore: Boolean(data.has_more),
          page,
        }));
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setState((s) => ({ ...s, loading: false, error: true }));
      }
    },
    [city, geo, filters.cuisine, filters.openNow, filters.sort, q],
  );

  useEffect(() => {
    if (enabled) void load(1);
    return () => abort.current?.abort();
  }, [enabled, load]);

  return {
    ...state,
    reload: () => load(1),
    loadMore: () => load(state.page + 1),
  };
}
