"use client";

/**
 * AddressAutocomplete — căutare de adrese prin proxy-ul intern /api/geo/search
 * (Nominatim server-side cu cache Redis 24h + rate limit + User-Agent corect).
 * Debounce 350ms + formatare titlu/oraș + buton ștergere (X).
 */
import { useEffect, useRef, useState } from "react";
import { X, MapPin } from "lucide-react";

export type AddressResult = {
  address: string;
  lat: number;
  lng: number;
  city?: string | null;
};

export default function AddressAutocomplete({
  placeholder,
  value,
  onSelect,
  onClear,
  icon,
  clearLabel = "Șterge",
}: {
  placeholder: string;
  value?: string;
  onSelect: (r: AddressResult) => void;
  onClear?: () => void;
  icon?: React.ReactNode;
  /** Etichetă a11y a butonului de ștergere (X); parametrizabilă prin props — vezi nota din LiveMarker.tsx. */
  clearLabel?: string;
}) {
  const [query, setQuery] = useState(value ?? "");
  const [results, setResults] = useState<AddressResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNext = useRef(false);

  useEffect(() => {
    if (value !== undefined) setQuery(value);
  }, [value]);

  // Închide dropdown-ul la click în exterior
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (skipNext.current) {
      skipNext.current = false;
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    if (query.trim().length < 3) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/geo/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!res.ok) throw new Error("geo search failed");
        const data: { results?: AddressResult[] } = await res.json();
        setResults(Array.isArray(data.results) ? data.results : []);
        setOpen(true);
      } catch {
        if (!controller.signal.aborted) setResults([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 350);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      controller.abort();
    };
  }, [query]);

  const handleClear = () => {
    setQuery("");
    setResults([]);
    setOpen(false);
    onClear?.();
  };

  return (
    <div className="relative" ref={containerRef}>
      <div className="flex items-center gap-2.5 rounded-2xl border border-neutral-200/80 bg-white px-3.5 py-3 shadow-sm focus-within:border-neutral-900 focus-within:ring-1 focus-within:ring-neutral-900/10 transition dark:border-neutral-700/80 dark:bg-neutral-900 dark:focus-within:border-white dark:focus-within:ring-white/10">
        {icon}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder={placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls="address-autocomplete-listbox"
          className="w-full bg-transparent text-[14px] font-semibold text-neutral-900 outline-none placeholder:font-normal placeholder:text-neutral-400 dark:text-neutral-100 dark:placeholder:text-neutral-500"
        />
        {loading ? (
          <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900 dark:border-neutral-600 dark:border-t-neutral-100" />
        ) : query ? (
          <button
            type="button"
            onClick={handleClear}
            aria-label={clearLabel}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900 transition dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
          >
            <X size={12} />
          </button>
        ) : null}
      </div>

      {open && results.length > 0 ? (
        <ul id="address-autocomplete-listbox" role="listbox" className="absolute z-[1000] mt-1.5 max-h-64 w-full overflow-auto rounded-2xl border border-neutral-200 bg-white p-1.5 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
          {results.map((r, i) => {
            const parts = r.address.split(",");
            const title = parts[0]?.trim() || r.address;
            const subtitle = parts.slice(1).join(",").trim();

            return (
              <li key={i} role="option" aria-selected={false}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-neutral-50 active:bg-neutral-100 dark:hover:bg-neutral-800 dark:active:bg-neutral-700"
                  onClick={() => {
                    skipNext.current = true;
                    setQuery(r.address);
                    setOpen(false);
                    onSelect(r);
                  }}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                    <MapPin size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-extrabold text-neutral-900 dark:text-neutral-100">
                      {title}
                    </span>
                    {subtitle ? (
                      <span className="block truncate text-[11px] text-neutral-500 font-medium dark:text-neutral-400">
                        {subtitle}
                      </span>
                    ) : null}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
