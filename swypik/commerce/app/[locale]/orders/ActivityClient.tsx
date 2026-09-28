"use client";

/**
 * /orders — „Comenzile mele" unificat: comenzi Eats + curse Go într-o singură
 * listă cronologică, cu link către tracking-ul potrivit.
 * Date: GET /api/me/activity (paginat, vezi app/api/me/activity/route.ts).
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "@/lib/i18n/navigation";
import { UtensilsCrossed, Car, ShoppingBag, ChevronRight, RotateCcw, PackageOpen } from "lucide-react";
import { haptic } from "@/lib/haptic";
import { useTranslations, useLocale } from "next-intl";

type ActivityItem = {
  kind: "food_order" | "ride" | "shop_order";
  id: string;
  status: string;
  ts: string;
  total_cents: number | null;
  currency: string;
  title: string;
  subtitle: string;
  href: string;
};

const ACTIVE_STATUSES = new Set([
  "placed", "accepted", "preparing", "ready", "picked_up", "delivering",
  "requested", "searching", "arriving", "in_progress",
  "authorized", "paid",
]);

const STATUS_KEYS = new Set([
  "placed", "accepted", "preparing", "ready", "picked_up", "delivering",
  "delivered", "cancelled", "rejected", "requested", "searching", "arriving",
  "in_progress", "completed", "authorized", "paid", "fulfilled", "refunded", "failed",
]);

function fmtMoney(cents: number | null, currency: string): string {
  if (cents == null) return "—";
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function fmtWhen(iso: string, locale: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(locale, { day: "numeric", month: "short" }) +
    ", " + d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-[#E5E5E5] dark:border-[#1F1F1F] p-4 animate-pulse">
      <div className="w-10 h-10 rounded-full bg-[#F0F0F0] dark:bg-[#1A1A1A]" />
      <div className="flex-1 space-y-2">
        <div className="h-3.5 w-2/3 rounded bg-[#F0F0F0] dark:bg-[#1A1A1A]" />
        <div className="h-3 w-1/3 rounded bg-[#F0F0F0] dark:bg-[#1A1A1A]" />
      </div>
    </div>
  );
}

export default function ActivityClient() {
  const t = useTranslations("ordersActivity");
  const locale = useLocale();
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: number, append: boolean) => {
    try {
      setError(null);
      if (append) setLoadingMore(true);
      const res = await fetch(`/api/me/activity?page=${p}&limit=20`, { cache: "no-store" });
      if (res.status === 401) {
        setError("auth");
        setItems([]);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items: ActivityItem[]; has_more: boolean };
      setItems((prev) => (append && prev ? [...prev, ...data.items] : data.items));
      setHasMore(data.has_more);
      setPage(p);
    } catch {
      setError("network");
      if (!append) setItems((prev) => prev ?? []);
    } finally {
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void load(1, false);
  }, [load]);

  return (
    <main className="mx-auto max-w-lg px-4 pt-6 pb-24">
      <h1 className="text-xl font-bold mb-4">{t("title")}</h1>

      {items === null && (
        <div className="space-y-3">
          <SkeletonRow /><SkeletonRow /><SkeletonRow />
        </div>
      )}

      {error === "auth" && (
        <div className="text-center py-16">
          <p className="text-sm text-[#71717A] mb-4">{t("authPrompt")}</p>
          <Link href="/auth/login" className="inline-block rounded-full bg-[#7C3AED] text-white px-6 py-2.5 text-sm font-semibold">
            {t("signIn")}
          </Link>
        </div>
      )}

      {error === "network" && (
        <div className="text-center py-10">
          <p className="text-sm text-[#71717A] mb-3">{t("networkError")}</p>
          <button
            type="button"
            onClick={() => { haptic("tap"); void load(page, false); }}
            className="inline-flex items-center gap-2 rounded-full border border-[#E5E5E5] dark:border-[#2A2A2A] px-5 py-2 text-sm font-medium"
          >
            <RotateCcw size={15} /> {t("retry")}
          </button>
        </div>
      )}

      {items !== null && !error && items.length === 0 && (
        <div className="text-center py-16">
          <PackageOpen size={40} className="mx-auto mb-3 text-[#A1A1AA]" strokeWidth={1.5} />
          <p className="text-sm text-[#71717A] mb-4">{t("empty")}</p>
          <div className="flex items-center justify-center gap-3">
            <Link href="/food" className="rounded-full bg-[#2DBE60] text-white px-5 py-2 text-sm font-semibold">{t("orderFood")}</Link>
            <Link href="/go" className="rounded-full bg-[#7C3AED] text-white px-5 py-2 text-sm font-semibold">{t("callRide")}</Link>
          </div>
        </div>
      )}

      {items !== null && items.length > 0 && (
        <ul className="space-y-3">
          {items.map((it) => {
            const active = ACTIVE_STATUSES.has(it.status);
            const Icon =
              it.kind === "food_order" ? UtensilsCrossed
                : it.kind === "shop_order" ? ShoppingBag
                  : Car;
            const accent =
              it.kind === "food_order" ? "#2DBE60"
                : it.kind === "shop_order" ? "#F59E0B"
                  : "#7C3AED";
            return (
              <li key={`${it.kind}-${it.id}`}>
                <Link
                  href={it.href}
                  onClick={() => haptic("tap")}
                  className={`flex items-center gap-3 rounded-2xl border p-4 transition-colors ${active
                    ? "border-transparent ring-1"
                    : "border-[#E5E5E5] dark:border-[#1F1F1F] hover:bg-[#FAFAFA] dark:hover:bg-[#111]"
                    }`}
                  style={active ? { boxShadow: `inset 0 0 0 1.5px ${accent}` } : undefined}
                >
                  <span
                    className="flex items-center justify-center w-10 h-10 rounded-full shrink-0"
                    style={{ backgroundColor: `${accent}1A`, color: accent }}
                  >
                    <Icon size={19} strokeWidth={2.2} />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold truncate">{it.title}</span>
                    <span className="block text-xs text-[#71717A] truncate">
                      {STATUS_KEYS.has(it.status) ? t(`status.${it.status}`) : it.status} · {fmtWhen(it.ts, locale)} · {it.subtitle}
                    </span>
                  </span>
                  <span className="text-right shrink-0">
                    <span className="block text-sm font-semibold">{fmtMoney(it.total_cents, it.currency)}</span>
                    {active && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: accent }}>
                        live <ChevronRight size={12} />
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {hasMore && (
        <div className="mt-4 text-center">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void load(page + 1, true)}
            className="rounded-full border border-[#E5E5E5] dark:border-[#2A2A2A] px-6 py-2.5 text-sm font-medium disabled:opacity-50"
          >
            {loadingMore ? t("loading") : t("loadMore")}
          </button>
        </div>
      )}
    </main>
  );
}
