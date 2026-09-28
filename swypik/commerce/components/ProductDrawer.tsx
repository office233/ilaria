"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { X, ShoppingCart, Star, ChevronRight, ExternalLink, ThumbsUp, ThumbsDown, CheckCircle2, Loader2 } from "lucide-react";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";
import { getSessionId, trackEvent as trackFeedEvent } from "@/lib/feed/track";
import { isCurrency, type Currency } from "@/lib/i18n/config";
import { useTranslations } from "next-intl";
import { routeForProduct } from "@/lib/products/product-route";

export interface ProductData {
  id: string | number;
  name?: string;
  title?: string;
  image?: string | null;
  image_url?: string | null;
  images?: string[];
  price?: number | string | null;
  priceCents?: number | null;
  priceDisplay?: string | null;
  currency?: string | null;
  priceRon?: number;
  description?: string | null;
  rating?: number;
  ratingCount?: number;
  reviews?: number;
  videoId?: string;
  deliveryLabel?: string | null;
  inventoryStatus?: string | null;
  swypikScore?: number | null;
  swypikScoreLabel?: string | null;
  votes?: {
    worthIt?: number;
    notWorthIt?: number;
    total?: number;
    viewerVote?: "worth_it" | "not_worth_it" | null;
  };
  [key: string]: any;
}

interface ProductDrawerProps {
  /** Produs deja încărcat din feed — afișat instant fără fetch */
  product?: ProductData | null;
  /** Alias compat: dacă pasezi un produs minimal din feed */
  initialProduct?: ProductData | null;
  onClose: () => void;
  onBuyNow: () => void;
  onVoteChange?: (product: ProductData) => void;
}

function cleanProductDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 8) return null;
  return cleaned.length > 260 ? `${cleaned.slice(0, 257).trim()}...` : cleaned;
}

export default function ProductDrawer({ product, initialProduct, onClose, onBuyNow, onVoteChange }: ProductDrawerProps) {
  const t = useTranslations("productDrawer");
  const formatPrice = useFormatPrice();
  const seed = product ?? initialProduct ?? null;
  const [data, setData] = useState<ProductData | null>(seed);
  const [isVisible, setIsVisible] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [votePending, setVotePending] = useState<"worth_it" | "not_worth_it" | null>(null);
  const [cartPending, setCartPending] = useState(false);
  const [cartMessage, setCartMessage] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const handleClose = useCallback(() => {
    setIsVisible(false);
    setTimeout(onClose, 300);
  }, [onClose]);

  // Body scroll lock
  useEffect(() => {
    setMounted(true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Escape to close + focus first interactive
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); handleClose(); }
      if (e.key === 'Tab' && containerRef.current) {
        const focusable = containerRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    // focus first
    setTimeout(() => {
      const el = containerRef.current?.querySelector<HTMLElement>('button, a[href]');
      el?.focus();
    }, 50);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleClose]);


  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 10);
    return () => clearTimeout(timer);
  }, []);

  // Lazy enrichment: dacă produsul din feed e minimal (lipsă descriere/variante),
  // facem fetch în background, fără să blocăm afișarea inițială (latență 0ms).
  useEffect(() => {
    if (!seed?.id) return;
    const needsDetail = !seed.description || seed.description.length < 10;
    if (!needsDetail) return;
    let cancelled = false;
    setEnriching(true);
    fetch(`/api/products/${seed.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j?.product) return;
        setData((cur) => ({ ...(cur || {}), ...j.product, id: cur?.id ?? j.product.id }));
      })
      .catch(() => { })
      .finally(() => !cancelled && setEnriching(false));
    return () => { cancelled = true; };
  }, [seed?.id, seed?.description]);

  if (!data || !mounted) return null;

  const productImage = data.image || data.images?.[0] || data.image_url || null;
  const productName = data.name || data.title || t("productFallback");
  const currencyCandidate = String(data.currency || "RON").trim().toUpperCase();
  const productCurrency: Currency = isCurrency(currencyCandidate) ? currencyCandidate : "RON";
  const numericPriceCents = Number(data.priceCents ?? data.price_cents);
  const priceCents = Number.isFinite(numericPriceCents) ? numericPriceCents : null;
  const rawPrice = data.price ?? data.priceRon;
  const productPriceDisplay = data.priceDisplay
    || (priceCents != null
      ? formatPrice(priceCents, { sourceCurrency: productCurrency })
      : typeof rawPrice === "number"
        ? formatPrice(Math.round(rawPrice * 100), { sourceCurrency: productCurrency })
        : typeof rawPrice === "string"
          ? rawPrice
          : "—");
  const productRating = data.rating || 4.5;
  const productReviews = data.ratingCount || data.reviews || 0;
  const productDescription = cleanProductDescription(data.description);
  const votes = data.votes || {};
  const worthIt = Number(votes.worthIt || 0);
  const notWorthIt = Number(votes.notWorthIt || 0);
  const totalVotes = Number(votes.total ?? worthIt + notWorthIt);
  const viewerVote = votes.viewerVote || null;
  const positivePct = totalVotes > 0 ? Math.round((worthIt / totalVotes) * 100) : null;
  const score = typeof data.swypikScore === "number" ? data.swypikScore : null;
  const inventoryLabel = data.inventoryStatus
    ? String(data.inventoryStatus).replace(/_/g, " ")
    : null;
  const productHref = routeForProduct(data);

  const applyOptimisticVote = (current: ProductData, vote: "worth_it" | "not_worth_it"): ProductData => {
    const currentVotes = current.votes || {};
    const previousVote = currentVotes.viewerVote || null;
    let nextWorth = Number(currentVotes.worthIt || 0);
    let nextNotWorth = Number(currentVotes.notWorthIt || 0);
    if (previousVote === "worth_it") nextWorth = Math.max(0, nextWorth - 1);
    if (previousVote === "not_worth_it") nextNotWorth = Math.max(0, nextNotWorth - 1);
    if (vote === "worth_it") nextWorth += 1;
    if (vote === "not_worth_it") nextNotWorth += 1;
    return {
      ...current,
      votes: {
        worthIt: nextWorth,
        notWorthIt: nextNotWorth,
        total: nextWorth + nextNotWorth,
        viewerVote: vote,
      },
    };
  };

  const handleVote = async (vote: "worth_it" | "not_worth_it") => {
    if (!data.videoId || !data.id || votePending || viewerVote === vote) return;
    const previous = data;
    const optimistic = applyOptimisticVote(data, vote);
    setData(optimistic);
    setVotePending(vote);

    try {
      const res = await fetch(`/api/videos/${data.videoId}/product-vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ productId: String(data.id), vote, sessionId: getSessionId() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "vote_failed");
      const nextProduct = { ...optimistic, votes: json.votes };
      setData(nextProduct);
      onVoteChange?.(nextProduct);
      trackFeedEvent("product_click", {
        video_id: String(data.videoId),
        metadata: { product_id: String(data.id), action: "product_vote", vote },
      });
    } catch {
      setData(previous);
    } finally {
      setVotePending(null);
    }
  };

  const handleAddToCart = async () => {
    if (!data.id || cartPending) return;
    setCartPending(true);
    setCartMessage(null);
    try {
      const res = await fetch("/api/cart/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          productId: String(data.id),
          quantity: 1,
          // Clipul din care cumpără — comisionul ajunge la creatorul lui.
          videoId: data.videoId ? String(data.videoId) : undefined,
          title: productName,
          image: productImage,
          priceCents: priceCents || undefined,
          currency: productCurrency,
        }),
      });
      if (!res.ok) throw new Error("cart_failed");
      setCartMessage(t("adaugat"));
      trackFeedEvent("add_to_cart", {
        video_id: data.videoId ? String(data.videoId) : undefined,
        metadata: { product_id: String(data.id), surface: "product_drawer" },
      });
      window.dispatchEvent(new CustomEvent("reward", { detail: { points: 10, msg: t("cosPlusXp") } }));
      setTimeout(() => setCartMessage(null), 1800);
    } catch {
      setCartMessage(t("incearcaDinNou"));
      setTimeout(() => setCartMessage(null), 1800);
    } finally {
      setCartPending(false);
    }
  };

  const drawer = (
    <>
      <div
        className={`fixed inset-0 z-[90] bg-black/40 backdrop-blur-[2px] transition-opacity duration-300 ${isVisible ? 'opacity-100' : 'opacity-0'}`}
        onClick={handleClose}
        aria-hidden="true"
      />

      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-drawer-title"
        tabIndex={-1}
        className={`fixed bottom-0 left-0 right-0 h-[70vh] z-[100] bg-black/80 backdrop-blur-xl rounded-t-3xl border-t border-white/10 flex flex-col transform transition-transform duration-300 ease-out ${isVisible ? 'translate-y-0' : 'translate-y-full'}`}
      >
        <div className="flex flex-col items-center p-4 border-b border-white/5 relative">
          <div className="w-12 h-1.5 bg-white/20 rounded-full mb-3" />
          <div className="flex items-center justify-between w-full">
            <h3 id="product-drawer-title" className="text-white font-semibold text-lg line-clamp-1 pr-4">
              {productName}
            </h3>
            <button
              onClick={handleClose}
              className="p-2 bg-white/10 rounded-full hover:bg-white/20 text-white transition-colors"
              aria-label={t("inchide")}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 scrollbar-hide">
          <div className="w-full aspect-square bg-white/5 rounded-2xl overflow-hidden mb-5 relative shadow-lg">
            {productImage ? (
              <Image
                src={productImage}
                alt={productName}
                fill
                sizes="(max-width: 640px) 92vw, 480px"
                className="object-cover"
                priority
                unoptimized={/\.gif($|\?)/i.test(productImage)}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-white/30">
                <ShoppingCart className="w-16 h-16" />
              </div>
            )}
            {productRating > 0 && (
              <div className="absolute top-3 left-3 bg-black/50 backdrop-blur-md rounded-full px-3 py-1 flex items-center gap-1 border border-white/10 z-10">
                <Star className="w-4 h-4 text-yellow-400 fill-yellow-400" />
                <span className="text-white text-sm font-bold">{productRating}</span>
                {productReviews > 0 && <span className="text-gray-300 text-xs">({productReviews})</span>}
              </div>
            )}
          </div>

          <div className="flex justify-between items-start mb-4">
            <div>
              <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">{t("pret")}</p>
              <h2 className="text-3xl font-bold text-[#10A37F]">{productPriceDisplay}</h2>
            </div>
            {score != null && (
              <div className="text-right">
                <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">Swypik Score</p>
                <div className="inline-flex items-center gap-2 rounded-full bg-yellow-300 px-3 py-1 text-sm font-black text-black">
                  {score}
                  <span className="text-[11px] font-bold text-black/70">{data.swypikScoreLabel || t("scoreFallback")}</span>
                </div>
              </div>
            )}
            {enriching && (
              <span className="text-[10px] uppercase tracking-wider text-white/40">{t("seIncarcaDetalii")}</span>
            )}
          </div>

          <div className="mb-5 flex flex-wrap gap-2 text-xs text-white/75">
            {inventoryLabel && (
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 capitalize">{inventoryLabel}</span>
            )}
            {data.deliveryLabel && (
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">{data.deliveryLabel}</span>
            )}
          </div>

          <div className="mb-6 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-white/45">{t("votComunitate")}</p>
                <p className="text-sm font-semibold text-white">
                  {positivePct == null ? t("spuneprimulMerita") : t("procentSpunMerita", { pct: positivePct })}
                </p>
              </div>
              <span className="text-xs text-white/45">{t("voturi", { count: totalVotes })}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => handleVote("worth_it")}
                disabled={Boolean(votePending)}
                aria-pressed={viewerVote === "worth_it"}
                className={`flex min-h-11 items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-bold transition active:scale-95 disabled:opacity-70 ${viewerVote === "worth_it" ? "border-[#10A37F] bg-[#10A37F] text-white" : "border-white/10 bg-white/10 text-white hover:bg-white/15"}`}
              >
                {votePending === "worth_it" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsUp className="h-4 w-4" />}

                {t("merita")}
                <span className="rounded-full bg-black/20 px-2 py-0.5 text-xs">{worthIt}</span>
              </button>
              <button
                type="button"
                onClick={() => handleVote("not_worth_it")}
                disabled={Boolean(votePending)}
                aria-pressed={viewerVote === "not_worth_it"}
                className={`flex min-h-11 items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-bold transition active:scale-95 disabled:opacity-70 ${viewerVote === "not_worth_it" ? "border-red-400 bg-red-500 text-white" : "border-white/10 bg-white/10 text-white hover:bg-white/15"}`}
              >
                {votePending === "not_worth_it" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsDown className="h-4 w-4" />}

                {t("nuMerita")}
                <span className="rounded-full bg-black/20 px-2 py-0.5 text-xs">{notWorthIt}</span>
              </button>
            </div>
          </div>

          <p className="text-gray-300 text-sm mb-6 leading-relaxed line-clamp-3">
            {productDescription || t("descriereFallback")}
          </p>

          <a
            href={productHref}
            className="flex items-center justify-between p-4 bg-white/5 rounded-xl hover:bg-white/10 transition-colors mb-6 group border border-white/10"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#10A37F]/20 flex items-center justify-center text-[#10A37F]">
                <ExternalLink className="w-5 h-5" />
              </div>
              <span className="text-white font-medium">{t("veziPaginaProdusului")}</span>
            </div>
            <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-white transition-colors" />
          </a>

          <a
            href={`/search?q=${encodeURIComponent(productName)}`}
            className="flex items-center justify-between p-4 bg-white/5 rounded-xl hover:bg-white/10 transition-colors mb-6 group border border-white/10"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-yellow-300/20 flex items-center justify-center text-yellow-300">
                <ChevronRight className="w-5 h-5" />
              </div>
              <span className="text-white font-medium">{t("alternativeMaiBune")}</span>
            </div>
            <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-white transition-colors" />
          </a>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-3 border-t border-white/10 bg-black/50 p-3 pb-safe sm:p-4">
          <button
            type="button"
            onClick={handleAddToCart}
            disabled={cartPending}
            className="flex min-h-14 min-w-0 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/10 px-3 py-3 text-[13px] font-bold leading-none text-white transition-colors hover:bg-white/20 active:scale-95 disabled:opacity-70 sm:text-sm"
          >
            {cartPending ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : cartMessage === t("adaugat") ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <ShoppingCart className="h-4 w-4 shrink-0" />}
            <span className="whitespace-nowrap">{cartMessage || t("adaugaInCos")}</span>
          </button>
          <button
            onClick={onBuyNow}
            className="min-h-14 min-w-0 rounded-xl bg-[#10A37F] px-4 py-3 text-sm font-bold leading-none text-white shadow-[0_0_20px_rgba(16,163,127,0.3)] transition-all hover:bg-[#0e8f6e] active:scale-95"
          >
            <span className="whitespace-nowrap">{t("cumparaAcum")}</span>
          </button>
        </div>
      </div>
    </>
  );

  return createPortal(drawer, document.body);
}
