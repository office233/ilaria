"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Hash, Package, Search, Tag, User } from "lucide-react";
import { useTranslations } from "next-intl";

type Suggestion = {
  label: string;
  type: "categorie" | "produs" | "hashtag" | "user";
  href?: string;
  count?: number;
};

type Props = {
  initialQuery?: string;
  placeholder?: string;
};

const ACCENT = "#0D0D0D";

export default function SearchBar({
  initialQuery = "",
  placeholder,
}: Props) {
  const router = useRouter();
  const t = useTranslations("searchBar");
  const effectivePlaceholder = placeholder ?? t("placeholder");
  const [q, setQ] = useState(initialQuery);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listboxId = "swypik-search-listbox";

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = q.trim();

    if (trimmed.length < 2) {
      setSuggestions([]);
      setOpen(false);
      setLoading(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      try {
        const res = await fetch(
          `/api/search/suggest?q=${encodeURIComponent(trimmed)}&limit=8`,
          { signal: ctrl.signal, cache: "no-store" }
        );
        const data = await res.json();
        setSuggestions(
          Array.isArray(data?.suggestions) ? data.suggestions.slice(0, 8) : []
        );
        setOpen(true);
        setActiveIdx(-1);
      } catch (err: any) {
        if (err?.name !== "AbortError") {
          setSuggestions([]);
        }
      } finally {
        setLoading(false);
      }
    }, 200);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q]);

  // Close dropdown on outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  function go(s: Suggestion) {
    setOpen(false);
    if (s.href) {
      router.push(s.href);
      return;
    }
    // Categorie / produs without explicit href → fall back to search results.
    const cleaned = s.label.replace(/^[#@]/, "").trim();
    if (cleaned.length === 0) return;
    router.push(`/search?q=${encodeURIComponent(cleaned)}`);
  }

  function submitQuery(value: string) {
    const v = value.trim();
    if (v.length < 2) return;
    setOpen(false);
    router.push(`/search?q=${encodeURIComponent(v)}`);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) {
      if (e.key === "Enter") {
        e.preventDefault();
        submitQuery(q);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx >= 0 && suggestions[activeIdx]) {
        go(suggestions[activeIdx]);
      } else {
        submitQuery(q);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  function iconFor(s: Suggestion) {
    if (s.type === "hashtag") return <Hash size={14} className="text-[#7C3AED]" />;
    if (s.type === "user") return <User size={14} className="text-[#7C3AED]" />;
    if (s.type === "produs") return <Package size={14} className="text-white/70" />;
    if (s.type === "categorie") return <Tag size={14} className="text-white/70" />;
    return <Search size={14} className="text-white/70" />;
  }

  function labelFor(s: Suggestion) {
    if (s.type === "hashtag") return t("typeHashtag");
    if (s.type === "user") return t("typeCreator");
    if (s.type === "produs") return t("typeProduct");
    return t("typeCategory");
  }

  const activeId = activeIdx >= 0 ? `${listboxId}-opt-${activeIdx}` : undefined;

  return (
    <div className="relative w-full" ref={containerRef}>
      <label htmlFor="swypik-search" className="sr-only">{t("searchLabel")}</label>
      <input
        id="swypik-search"
        name="q"
        autoComplete="off"
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => {
          if (suggestions.length > 0) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        placeholder={effectivePlaceholder}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={listboxId}
        aria-activedescendant={activeId}
        className="w-full rounded-lg bg-neutral-900 border border-neutral-800 px-4 py-2 text-white placeholder-neutral-500 focus:outline-none"
        style={{ caretColor: ACCENT }}
      />

      {loading && (
        <div
          className="absolute right-3 top-1/2 -translate-y-1/2 text-xs"
          style={{ color: ACCENT }}
        >
          …
        </div>
      )}

      {open && suggestions.length > 0 && (
        <ul
          id={listboxId}
          className="absolute z-50 left-0 right-0 mt-1 max-h-96 overflow-auto rounded-lg border border-neutral-800 bg-neutral-950 shadow-xl"
          role="listbox"
        >
          {suggestions.map((s, i) => {
            const active = i === activeIdx;
            return (
              <li
                id={`${listboxId}-opt-${i}`}
                key={`${s.type}-${s.label}-${i}`}
                role="option"
                aria-selected={active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  go(s);
                }}
                onMouseEnter={() => setActiveIdx(i)}
                className="flex items-center gap-3 px-3 py-2 cursor-pointer"
                style={{
                  backgroundColor: active ? "#1a1a1a" : "transparent",
                }}
              >
                <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-neutral-900">
                  {iconFor(s)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white truncate">{s.label}</div>
                  <div className="text-xs text-white/50">
                    {labelFor(s)}
                    {typeof s.count === "number" && s.count > 0 ? ` · ${s.count}` : ""}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
