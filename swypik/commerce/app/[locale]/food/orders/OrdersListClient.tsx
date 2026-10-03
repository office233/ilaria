"use client";

/**
 * /food/orders — istoricul comenzilor + re-comandă cu un tap.
 * Comenzile active apar primele, cu link direct la tracking.
 */
import { useEffect, useState } from "react";
import { useRouter as useNextRouter } from "next/navigation";
import { useRouter } from "@/lib/i18n/navigation";
import Image from "next/image";
import { ArrowLeft, ChevronRight, RotateCcw, UtensilsCrossed } from "lucide-react";
import { haptic } from "@/lib/haptic";
import { useTranslations, useLocale } from "next-intl";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";

const ACCENT = "#2DBE60";

type OrderRow = {
  id: string;
  order_number: string;
  status: string;
  items: { menu_item_id: string; name: string; qty: number; unit_price_cents: number; options?: { id?: string; name: string }[] }[];
  total_cents: number;
  placed_at: string;
  merchant_name: string;
  merchant_slug: string | null;
  merchant_image: string | null;
};

const ACTIVE = ["placed", "accepted", "preparing", "ready", "picked_up", "delivering"];

/** Statusurile sunt traduse prin cheile foodOrders.st_<status>. */

export default function OrdersListClient() {
  const router = useRouter();
  const nextRouter = useNextRouter(); // doar pentru /auth (rută non-localizată)
  const fmt = useFormatPrice();
  const t = useTranslations("foodOrders");
  const locale = useLocale();
  const statusLabel = (s: string) => {
    try { return t(`st_${s}` as never); } catch { return s; }
  };
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);

  useEffect(() => {
    fetch("/api/local-orders?limit=50", { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 401) { setNeedsAuth(true); return null; }
        return r.json();
      })
      .then((d) => { if (d?.success) setOrders(d.orders); })
      .catch(() => setOrders([]));
  }, []);

  const fmtLei = (c: number) => fmt(c);

  const reorder = (o: OrderRow) => {
    haptic("tap");
    if (!o.merchant_slug) return;
    // Repunem exact aceleași linii în coșul localStorage al restaurantului.
    // Cheia coșului e per-merchant; luăm merchant_id din prima linie nu îl avem —
    // deci pasăm comanda prin query și MenuClient o rehidratează server-verified.
    router.push(`/food/${o.merchant_slug}?reorder=${o.id}`);
  };

  const active = (orders ?? []).filter((o) => ACTIVE.includes(o.status));
  const past = (orders ?? []).filter((o) => !ACTIVE.includes(o.status));

  return (
    <div className="min-h-dvh bg-[#F7F7F8] dark:bg-fg pb-10">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-[#E5E5E5] dark:border-[#1F1F1F] bg-surface dark:bg-[#111113] px-4 py-3">
        <button type="button" onClick={() => router.push("/food")} aria-label={t("back")} className="grid h-9 w-9 place-items-center rounded-full bg-[#F7F7F8] dark:bg-[#1F1F23] dark:text-white active:scale-95">
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-base font-black dark:text-white">{t("title")}</h1>
      </header>

      <main className="mx-auto max-w-lg space-y-6 px-4 pt-4">
        {needsAuth && (
          <div className="rounded-2xl border border-[#E5E5E5] dark:border-[#1F1F1F] bg-surface dark:bg-[#111113] p-6 text-center">
            <p className="text-sm font-bold dark:text-white">{t("signInPrompt")}</p>
            <button
              type="button"
              onClick={() => nextRouter.push("/auth/login?next=/food/orders")}
              style={{ backgroundColor: ACCENT }}
              className="mt-3 h-11 rounded-xl px-5 text-sm font-bold text-white active:scale-95"
            >
              {t("signIn")}
            </button>
          </div>
        )}

        {orders == null && !needsAuth && (
          <div className="grid place-items-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#2DBE60] border-t-transparent" aria-label={t("loading")} />
          </div>
        )}

        {orders != null && orders.length === 0 && (
          <div className="rounded-2xl border border-[#E5E5E5] dark:border-[#1F1F1F] bg-surface dark:bg-[#111113] p-8 text-center">
            <div className="flex justify-center dark:text-white" aria-hidden><UtensilsCrossed size={48} /></div>
            <p className="mt-3 text-sm font-bold dark:text-white">{t("empty")}</p>
            <button
              type="button"
              onClick={() => router.push("/food")}
              style={{ backgroundColor: ACCENT }}
              className="mt-4 h-11 rounded-xl px-5 text-sm font-bold text-white active:scale-95"
            >
              {t("explore")}
            </button>
          </div>
        )}

        {active.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs font-black uppercase tracking-wide text-muted dark:text-subtle">{t("inProgress")}</h2>
            <div className="space-y-3">
              {active.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => { haptic("tap"); router.push(`/food/orders/${o.id}`); }}
                  className="flex w-full items-center gap-3 rounded-2xl border-2 bg-surface dark:bg-[#111113] p-4 text-left active:scale-[0.98]"
                  style={{ borderColor: ACCENT }}
                >
                  <OrderThumb image={o.merchant_image} name={o.merchant_name} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-black dark:text-white">{o.merchant_name}</p>
                    <p className="text-xs font-bold" style={{ color: ACCENT }}>{statusLabel(o.status)} · {t("live")}</p>
                  </div>
                  <ChevronRight size={18} className="shrink-0 text-[#9C9CAB]" />
                </button>
              ))}
            </div>
          </section>
        )}

        {past.length > 0 && (
          <section>
            <h2 className="mb-2 text-xs font-black uppercase tracking-wide text-muted dark:text-subtle">{t("history")}</h2>
            <div className="space-y-3">
              {past.map((o) => (
                <div key={o.id} className="rounded-2xl border border-[#E5E5E5] dark:border-[#1F1F1F] bg-surface dark:bg-[#111113] p-4">
                  <button
                    type="button"
                    onClick={() => { haptic("tap"); router.push(`/food/orders/${o.id}`); }}
                    className="flex w-full items-center gap-3 text-left"
                  >
                    <OrderThumb image={o.merchant_image} name={o.merchant_name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-black dark:text-white">{o.merchant_name}</p>
                      <p className="truncate text-xs text-muted dark:text-subtle">
                        {(o.items ?? []).map((it) => `${it.qty}× ${it.name}`).join(", ")}
                      </p>
                      <p className="mt-0.5 text-xs text-[#9C9CAB]">
                        {new Date(o.placed_at).toLocaleDateString(locale, { day: "numeric", month: "short" })} · {statusLabel(o.status)} · {fmtLei(o.total_cents)}
                      </p>
                    </div>
                    <ChevronRight size={18} className="shrink-0 text-[#9C9CAB]" />
                  </button>
                  {o.status === "delivered" && o.merchant_slug && (
                    <button
                      type="button"
                      onClick={() => reorder(o)}
                      className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[#F0FAF4] dark:bg-[#0F2A1B] text-xs font-black active:scale-[0.98]"
                      style={{ color: ACCENT }}
                    >
                      <RotateCcw size={14} /> {t("reorderBtn")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function OrderThumb({ image, name }: { image: string | null; name: string }) {
  return image ? (
    <Image src={image} alt={name} width={48} height={48} className="h-12 w-12 shrink-0 rounded-xl object-cover" />
  ) : (
    <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[#F7F7F8] dark:bg-[#1F1F23] dark:text-white" aria-hidden><UtensilsCrossed size={20} /></span>
  );
}
