"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Package, Search, Send, ShoppingCart, SlidersHorizontal, Star, X } from "lucide-react";
import ProductFeed from "./ProductFeed";
import OffersFeed from "./home/OffersFeed";
import CategorySidebar, { type CategoryNode } from "./home/CategorySidebar";
import EcosystemBar from "./home/EcosystemBar";
import AppMenuButton from "./nav/AppMenuButton";
import { IconButton } from "./ui/IconButton";
import type { OfferPost } from "@/lib/types/feed";
import { THEME, commerceBadgeClass } from "@/lib/ui/theme";
import { Link } from "@/lib/i18n/navigation";

import Image from "next/image";

import type { Product } from "@/types/product";
import type { CartItem } from "@/types/cart";
import { mergeIntoCart, cartItemKey } from "@/types/cart";
import { isUuid } from "@/lib/validation/uuid";
import { useTranslations, useLocale } from "next-intl";
import type { Locale } from "@/lib/i18n/config";
import { formatPriceLegacy } from "@/lib/i18n/currency";
import ProductModal from "./chat/ProductModal";
import { fetchSocialFeed } from "@/lib/chat/feed-normalize";

type ChatProduct = Product; // alias for backwards compat within this file

type ChatMessage = { id: string; role: "user" | "assistant"; content: string; products?: ChatProduct[]; bundleProducts?: ChatProduct[]; timestamp: Date };
type Tab = "home" | "chat" | "deals" | "feed" | "cart";
type FunnelStage = "discover" | "compare" | "consider" | "cart" | "checkout" | "upsell";

/** POST /api/chat response shape (see app/api/chat/route.ts). */
type ChatApiResponse = {
  intent?: string;
  reply?: string;
  products?: ChatProduct[];
  bundleProducts?: ChatProduct[];
  sessionId?: string;
  productId?: string;
  productTitle?: string;
  error?: string;
};

export default function ChatInterface({
  initialTrending = [],
  // Fetched server-side (see app/[locale]/page.tsx) but there is no "best value" /
  // "top rated" carousel wired into this redesign (chat + OffersFeed centric) —
  // kept as accepted props so the caller's contract doesn't change; prefixed with
  // `_` (this project's allowed-unused convention) instead of holding dead state.
  initialBestValue: _initialBestValue = [],
  initialTopRated: _initialTopRated = [],
  initialOffers = []
}: {
  initialTrending?: ChatProduct[],
  initialBestValue?: ChatProduct[],
  initialTopRated?: ChatProduct[],
  initialOffers?: OfferPost[]
}) {
  const t = useTranslations("chatInterface");
  const locale = useLocale() as Locale;
  /** Formats a whole-RON price for the current locale (Product prices are stored as whole RON units). */
  const money = useCallback((amount: number) => formatPriceLegacy(amount, { locale }), [locale]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    try {
      // Schema v2: invalidăm istoricul vechi (conținea produse din catalogul vechi
      // rămase în localStorage după golirea catalogului).
      const SCHEMA = "v2";
      if (localStorage.getItem("aicv_chat_schema") !== SCHEMA) {
        localStorage.removeItem("aicv_chat");
        localStorage.setItem("aicv_chat_schema", SCHEMA);
        return;
      }
      const saved = localStorage.getItem("aicv_chat");
      if (saved) {
        const parsed = JSON.parse(saved) as Array<ChatMessage & { timestamp: string }>;
        setMessages(parsed.map((m) => ({ ...m, timestamp: new Date(m.timestamp) })));
      }
    } catch { }
  }, []);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("home");
  const [sessionId, setSessionId] = useState("");
  const [trendingProducts] = useState<ChatProduct[]>(initialTrending);
  const [dealsProducts, setDealsProducts] = useState<ChatProduct[]>([]);
  const [dealsLoading, setDealsLoading] = useState(false);
  const [feedProducts, setFeedProducts] = useState<ChatProduct[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<ChatProduct | null>(null);
  const openOfferProduct = useCallback((post: OfferPost) => {
    setSelectedProduct({
      id: post.id,
      title: post.title,
      description: post.title,
      benefits: [],
      whyBuy: "",
      warnings: [],
      dealLabel: post.discountPercent > 0 ? `-${post.discountPercent}%` : "AI Pick",
      price: post.price,
      oldPrice: post.oldPrice,
      discountPercent: post.discountPercent,
      rating: post.rating || 0,
      orders: post.orders || 0,
      deliveryDays: 0,
      images: [post.image],
      hasVideo: false,
      category: post.category,
      categoryId: post.categoryId,
      gradient: "from-orange-500 to-pink-500",
      qualityScore: 8,
    } as unknown as ChatProduct);
  }, []);
  const [lastShownProducts, setLastShownProducts] = useState<ChatProduct[]>([]);
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [toastMessage, setToastMessage] = useState("");
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [funnelStage, setFunnelStage] = useState<FunnelStage>("discover");
  const [upsellProduct, setUpsellProduct] = useState<ChatProduct | null>(null);
  const [categoryTree, setCategoryTree] = useState<CategoryNode[]>([]);
  const [homeCategory, setHomeCategory] = useState<string | null>(null);
  const [categoryDrawerOpen, setCategoryDrawerOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const feedSeed = useRef(Math.floor(Math.random() * 100000));
  const dealsLoadingRef = useRef(false);
  const feedLoadingRef = useRef(false);

  const loadDeals = useCallback(async () => {
    if (dealsLoadingRef.current) return;
    dealsLoadingRef.current = true;
    setDealsLoading(true);
    try {
      const data = await fetch("/api/products?mode=deals&limit=50&sort=popular").then((r) => r.json());
      setDealsProducts(data.products || []);
    } finally {
      dealsLoadingRef.current = false;
      setDealsLoading(false);
    }
  }, []);

  const loadFeed = useCallback(async () => {
    if (feedLoadingRef.current) return;
    feedLoadingRef.current = true;
    setFeedLoading(true);
    try {
      setFeedProducts(await fetchSocialFeed(0, feedSeed.current));
    } finally {
      feedLoadingRef.current = false;
      setFeedLoading(false);
    }
  }, []);

  const loadMoreFeed = useCallback(async () => {
    if (feedLoadingRef.current) return;
    feedLoadingRef.current = true;
    setFeedLoading(true);
    try {
      const offset = feedProducts.length;
      const nextProducts = await fetchSocialFeed(offset, feedSeed.current);
      setFeedProducts((prev) => {
        const existing = new Set(prev.map((p) => p.id));
        return [...prev, ...nextProducts.filter((p) => !existing.has(p.id))];
      });
    } finally {
      feedLoadingRef.current = false;
      setFeedLoading(false);
    }
  }, [feedProducts.length]);

  // Persist cart to localStorage
  /* legacy aicv_cart persistence removed — server-side /api/cart is source of truth */
  // Persist chat messages (last 20) to localStorage
  useEffect(() => { try { const toSave = messages.slice(-20).map(m => ({ ...m, products: m.products?.slice(0, 4), bundleProducts: m.bundleProducts?.slice(0, 4) })); localStorage.setItem("aicv_chat", JSON.stringify(toSave)); } catch { } }, [messages]);

  useEffect(() => {
    setSessionId(Math.random().toString(36).slice(2) + Date.now().toString(36));
    fetch("/api/products?hierarchy=true").then(r => r.json()).then((d: { hierarchy?: CategoryNode[] }) => setCategoryTree(d.hierarchy || [])).catch(() => { });
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("mode") === "feed") {
      setActiveTab("feed");
      loadFeed();
    }
  }, [loadFeed]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isLoading]);
  useEffect(() => {
    if (activeTab === "deals" && dealsProducts.length === 0) loadDeals();
    if (activeTab === "feed" && feedProducts.length === 0) loadFeed();
  }, [activeTab, dealsProducts.length, feedProducts.length, loadDeals, loadFeed]);

  const cartTotal = cartItems.reduce((sum, item) => sum + item.product.price * item.qty, 0);
  const cartCount = cartItems.reduce((sum, item) => sum + item.qty, 0);
  // Coșul de pe server e sursa de adevăr (checkout-ul îl citește): adăugăm local
  // doar după confirmare. SKU-ul furnizorului nu e o variantă Swypik — trimitem
  // variantId doar când e un id de variantă; produsele cu variante obligatorii
  // se deschid pe pagina produsului ca să se aleagă varianta.
  async function addToCart(product: ChatProduct, quantity: number = 1) {
    const productId = product.pgId || product.id;
    const variantId = isUuid(product.skuId) ? product.skuId : null;
    let code: string | null = null;
    try {
      const res = await fetch("/api/cart/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ productId, quantity, variantId }),
      });
      if (!res.ok) code = ((await res.json().catch(() => ({}))) as { code?: string }).code ?? "error";
    } catch {
      code = "error";
    }
    if (code === "variant_required" || code === "variant_unavailable") {
      window.location.href = `/product/${productId}`;
      return;
    }
    if (code) {
      setToastMessage(t("adaugareInCosEsuata"));
      return;
    }
    setCartItems((prev) => mergeIntoCart(prev, product, quantity));
    setSelectedProduct(null); setToastMessage(t("produsAdaugatInCos", { title: `${quantity > 1 ? quantity + "x " : ""}${product.title.slice(0, 24)}` })); setFunnelStage("upsell");
    const newKey = `${product.pgId || product.id}:${product.skuId || "base"}`;
    const candidate = lastShownProducts.find((p) => `${p.pgId || p.id}:${p.skuId || "base"}` !== newKey && !cartItems.some((item) => cartItemKey(item) === `${p.pgId || p.id}:${p.skuId || "base"}`));
    if (candidate) setUpsellProduct(candidate);
    setTimeout(() => setToastMessage(""), 2500);
  }

  function findProductForAI(data: ChatApiResponse) { const all = [...lastShownProducts, ...(data.products || []), ...(data.bundleProducts || [])]; if (data.productId) return all.find((p) => p.id === data.productId); if (data.productTitle) { const needle = String(data.productTitle).toLowerCase(); return all.find((p) => p.title.toLowerCase().includes(needle)); } return all.length === 1 ? all[0] : null; }

  async function sendMessage(text?: string) {
    const msg = (text || input).trim(); if (!msg || isLoading) return;
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: "user", content: msg, timestamp: new Date() };
    setMessages((prev) => [...prev, userMsg]); setInput(""); setIsLoading(true); setActiveTab("chat");
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: msg, sessionId, productContext: lastShownProducts.slice(0, 12), chatHistory: messages.slice(-10).map((m) => ({ role: m.role, content: m.content })) }) });
      const data: ChatApiResponse = await res.json(); if (!res.ok) throw new Error(data?.error || t("errCauta"));
      setFunnelStage(data.intent === "add_to_cart" ? "cart" : data.intent === "checkout" ? "checkout" : data.intent === "find_cheaper" ? "compare" : data.intent === "search_product" ? "discover" : funnelStage);
      if (data.intent === "add_to_cart") { const product = findProductForAI(data); if (product) addToCart(product); }
      const products = data.products || []; const bundleProducts = data.bundleProducts || [];
      if (products.length || bundleProducts.length) setLastShownProducts([...products, ...bundleProducts]);
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: data.reply || t("amCautatInMagazin"), products, bundleProducts, timestamp: new Date() }]);
      if (data.sessionId) setSessionId(data.sessionId);
    } catch (error) { const message = error instanceof Error ? error.message : t("errGenerica"); setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: message || t("errGenerica"), timestamp: new Date() }]); } finally { setIsLoading(false); }
  }

  const [touchStart, setTouchStart] = useState<{ x: number, y: number } | null>(null);

  function updateQty(index: number, delta: number) { setCartItems((prev) => { const next = [...prev]; next[index] = { ...next[index], qty: Math.max(0, next[index].qty + delta) }; return next.filter((item) => item.qty > 0); }); }
  // Bug fix (i18n/UI audit 2026-09-24): checkoutLoading was read (to disable the
  // button + show "Se procesează") but never actually set, so a double-tap could
  // fire /checkout navigation twice and the loading state never appeared.
  async function submitOrder() { if (cartItems.length === 0 || checkoutLoading) return; setCheckoutLoading(true); window.location.href = "/checkout"; }

  const isSwipeCandidate = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    return !target.closest("button,a,input,textarea,select,[role='button'],.overflow-x-auto");
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!isSwipeCandidate(e.target)) {
      setTouchStart(null);
      return;
    }
    if (e.touches.length === 1) setTouchStart({ x: e.touches[0].clientX, y: e.touches[0].clientY });
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStart) return;
    const dx = touchStart.x - e.changedTouches[0].clientX;
    const dy = touchStart.y - e.changedTouches[0].clientY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      const tabs: Tab[] = ["home", "feed", "chat", "cart"];
      const idx = tabs.indexOf(activeTab);
      if (dx > 0 && idx >= 0 && idx < tabs.length - 1) setActiveTab(tabs[idx + 1]);
      if (dx < 0 && idx > 0) setActiveTab(tabs[idx - 1]);
    }
    setTouchStart(null);
  };

  const [cardQty, setCardQty] = useState<Record<string, number>>({});
  const getCardQty = (id: string) => cardQty[id] || 1;
  const updateCardQty = (id: string, delta: number) => setCardQty(prev => ({ ...prev, [id]: Math.max(1, (prev[id] || 1) + delta) }));

  const ProductCard = ({ product, compact = false }: { product: ChatProduct; compact?: boolean }) => {
    const badge = product.commerceBadge;
    const insight = product.rating >= 4.8 && product.orders >= 200 ? t("insightAboveAverageQuality") : product.orders >= 500 ? t("insightVerifiedSeller") : product.discountPercent >= 25 ? t("reducereReala") : product.qualityScore >= 9 ? t("insightBestValue") : null;
    const q = getCardQty(product.id);
    const vc = product.variantsCount || 0;
    return (
      <div className={`${compact ? "w-[10.5rem] sm:w-[11.5rem] shrink-0 carousel-card" : ""} overflow-hidden rounded-2xl bg-white dark:bg-[#111113] border border-[#E5E5E5] dark:border-[#1F1F1F] md:hover:border-[#D1D1D6] dark:md:hover:border-[#3F3F46] md:hover:shadow-md transition-all`}>
        <a href={`/product/${product.pgId || product.id}`} className="block" style={{ touchAction: "manipulation" }}>
          <div className="relative h-40 sm:h-44 bg-[#F7F7F8] dark:bg-[#1F1F23] product-card-image group">
            {product.images?.[0] ? <Image src={product.images[0]} alt={product.title} width={250} height={250} className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center"><Package className="text-[#D1D1D6] dark:text-[#3F3F46]" /></div>}
            {product.hasVideo && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/40 transition-colors">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/90 shadow-lg backdrop-blur-sm">
                  <div className="ml-1 h-0 w-0 border-y-[6px] border-l-[10px] border-y-transparent border-l-[#0D0D0D]"></div>
                </div>
              </div>
            )}
            {product.discountPercent > 0 && <span className="absolute right-2 top-2 rounded-full bg-[#DC2626] px-2.5 py-1 text-[10px] font-black text-white z-10">-{product.discountPercent}%</span>}
            {badge && <span className={`absolute left-2 top-2 max-w-[80%] rounded-full px-2.5 py-1 text-[10px] font-black shadow z-10 ${commerceBadgeClass(badge)}`}>{badge}</span>}
            {vc > 1 && <span className="absolute left-2 bottom-2 rounded-full bg-[#0D0D0D]/80 px-2 py-0.5 text-[9px] font-bold text-white backdrop-blur z-10">{t("variantsCount", { count: vc })}</span>}
          </div>
        </a>
        <div className="p-3">
          <p className="line-clamp-2 text-[13px] sm:text-sm font-bold leading-tight text-[#0D0D0D] dark:text-white product-card-title">{product.title}</p>
          {insight && <p className="mt-1 text-[11px] font-semibold text-[#0D0D0D] dark:text-white">{insight}</p>}
          <div className="mt-1 flex items-center gap-2 text-[11px] font-medium text-[#6E6E80] dark:text-[#A1A1AA]">
            <span className="text-[#B45309] inline-flex items-center gap-0.5"><Star size={12} fill="currentColor" /> {product.rating?.toFixed?.(1) || "4.8"}</span>
            <span>{t("ordersSuffix", { count: product.orders || 0 })}</span>
          </div>
          <div className="mt-2 flex items-end gap-2">
            <span className="text-base sm:text-lg font-black text-[#0D0D0D] dark:text-white product-card-price">{money(product.price)}</span>
            {product.oldPrice > product.price && <span className="text-[11px] text-[#6E6E80] dark:text-[#A1A1AA] line-through">{money(product.oldPrice)}</span>}
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <div className="flex items-center rounded-lg border border-[#E5E5E5] dark:border-[#1F1F1F] overflow-hidden" onClick={e => e.stopPropagation()}>
              <button type="button" onClick={(e) => { e.stopPropagation(); updateCardQty(product.id, -1); }} className="qty-btn grid h-11 w-11 place-items-center text-[#6E6E80] dark:text-[#A1A1AA] hover:bg-[#F7F7F8] dark:hover:bg-[#1F1F23] active:scale-90 transition-all text-base font-bold" style={{ touchAction: "manipulation" }}>−</button>
              <span className="w-6 text-center text-xs font-black text-[#0D0D0D] dark:text-white">{q}</span>
              <button type="button" onClick={(e) => { e.stopPropagation(); updateCardQty(product.id, 1); }} className="qty-btn grid h-11 w-11 place-items-center text-[#6E6E80] dark:text-[#A1A1AA] hover:bg-[#F7F7F8] dark:hover:bg-[#1F1F23] active:scale-90 transition-all text-base font-bold" style={{ touchAction: "manipulation" }}>+</button>
            </div>
            <button type="button" onClick={(e) => { e.stopPropagation(); addToCart(product, q); setCardQty(prev => ({ ...prev, [product.id]: 1 })); }} className={`flex-1 rounded-lg py-3 text-xs font-bold min-h-[44px] ${THEME.classes.cartButton} dark:bg-white dark:text-black dark:hover:bg-[#E5E5E5]`} style={{ touchAction: "manipulation" }}>
              <ShoppingCart size={13} className="mr-1 inline" />{q > 1 ? t("cosQty", { qty: q }) : t("cosShort")}
            </button>
          </div>
        </div>
      </div>
    );
  };
  const ProductSkeleton = ({ compact = false }) => <div className={`${compact ? "w-[10.5rem] sm:w-[11.5rem] shrink-0 carousel-card" : ""} overflow-hidden rounded-2xl bg-white dark:bg-[#111113] border border-[#E5E5E5] dark:border-[#1F1F1F] animate-pulse`}><div className="h-40 sm:h-44 bg-[#F7F7F8] dark:bg-[#1F1F23] product-card-image"></div><div className="p-3"><div className="h-4 bg-[#F7F7F8] dark:bg-[#1F1F23] rounded mb-2 w-3/4"></div><div className="h-4 bg-[#F7F7F8] dark:bg-[#1F1F23] rounded mb-4 w-1/2"></div><div className="h-6 bg-[#F7F7F8] dark:bg-[#1F1F23] rounded w-1/3"></div><div className="mt-2 h-8 w-full rounded-lg bg-[#F7F7F8] dark:bg-[#1F1F23]"></div></div></div>;
  const ProductCarousel = ({ title, products, isLoading }: { title: string; products?: ChatProduct[]; isLoading?: boolean }) => { if (isLoading) return <div className="mt-4 text-left"><p className="mb-2 text-xs font-bold uppercase tracking-widest text-[#6E6E80] dark:text-[#A1A1AA]">{title}</p><div className="flex snap-x gap-3 overflow-x-auto pb-3 no-scrollbar"><div className="snap-start"><ProductSkeleton compact /></div><div className="snap-start"><ProductSkeleton compact /></div><div className="snap-start"><ProductSkeleton compact /></div></div></div>; if (!products?.length) return null; return <div className="mt-4 text-left" onTouchStart={(e) => e.stopPropagation()} onTouchEnd={(e) => e.stopPropagation()}><p className="mb-2 text-xs font-bold uppercase tracking-widest text-[#6E6E80] dark:text-[#A1A1AA]">{title}</p><div className="flex snap-x gap-3 overflow-x-auto pb-3 no-scrollbar">{products.map((p) => <div key={p.id} className="snap-start"><ProductCard product={p} compact /></div>)}</div></div>; };

  const welcomeMessage: ChatMessage = { id: "welcome", role: "assistant", content: t("welcomeContent"), timestamp: new Date() };

  return <main className={`min-h-screen ${THEME.classes.appBg} dark:bg-black dark:text-white`}><div className={`relative mx-auto min-h-screen w-full md:max-w-2xl lg:max-w-4xl xl:max-w-6xl app-container ${THEME.classes.pageBg} dark:bg-black`}>{activeTab !== "feed" && <header className="sticky top-0 z-30 border-b border-[#E5E5E5] dark:border-[#1F1F1F] bg-white/95 dark:bg-black/95 px-4 py-3 backdrop-blur-xl safe-top"><div className="flex items-center justify-between h-12"><div className="flex items-center gap-1"><AppMenuButton /><button type="button" onClick={() => { setActiveTab("home"); if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" }); }} className="flex items-center gap-2" aria-label={t("inapoiAcasa")}><span className="text-2xl font-black text-[#0D0D0D] dark:text-white tracking-tight">Swypik</span></button></div><div className="flex items-center gap-1"><IconButton label={t("categorii")} onClick={() => setCategoryDrawerOpen(true)}><SlidersHorizontal aria-hidden /></IconButton><IconButton asChild label={t("cauta")}><Link href="/search"><Search aria-hidden /></Link></IconButton><a href="/cart" aria-label={t("cosulMeu")} className="relative grid h-11 w-11 place-items-center rounded-full bg-[#0D0D0D] dark:bg-white text-white dark:text-black active:scale-95 transition-transform focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none"><ShoppingCart size={18} />{cartCount > 0 && <span className="absolute top-0.5 right-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-full bg-[#7C3AED] px-1 text-[9px] font-black text-white leading-none ring-2 ring-[#0D0D0D] dark:ring-white">{cartCount > 99 ? "99+" : cartCount}</span>}</a></div></div></header>}
    <section className={activeTab === "feed" ? "h-[100dvh]" : "min-h-[calc(100dvh-132px)] pb-20"} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      {activeTab === "home" && (
        <div className="px-2 pt-2 sm:px-4 sm:pt-4">
          {/* Feed social centrat; categoriile stau in drawer-ul din ☰ (langa logo) */}
          <CategorySidebar
            categories={categoryTree}
            activeCategory={homeCategory}
            onSelectCategory={setHomeCategory}
            open={categoryDrawerOpen}
            onOpenChange={setCategoryDrawerOpen}
          />
          <EcosystemBar className="-mx-2 mb-3 sm:-mx-4" />
          <div className="mx-auto min-w-0 max-w-xl">
            <OffersFeed
              initialItems={initialOffers}
              category={homeCategory}
              onOpenProduct={openOfferProduct}
            />
          </div>
          {/* Buton plutitor: asistentul AI de shopping */}
          <button
            type="button"
            onClick={() => setActiveTab("chat")}
            aria-label={t("asistentShoppingAi")}
            className="fixed bottom-24 right-4 z-30 grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-violet-600 to-pink-500 text-white shadow-lg shadow-violet-500/30 transition-transform hover:scale-105 active:scale-95 safe-bottom"
          >
            <Bot size={24} />
          </button>
        </div>
      )}
      {activeTab === "chat" && <div className="px-4 pt-4"><div className="space-y-4">{(messages.length === 0 ? [welcomeMessage] : messages).map((m) => <div key={m.id} className={m.role === "user" ? "text-right" : "text-left"}><div className={`inline-block max-w-[88%] rounded-2xl px-4 py-3 text-sm font-medium ${m.role === "user" ? "bg-[#0D0D0D] text-white dark:bg-white dark:text-black" : "bg-[#F7F7F8] text-[#0D0D0D] border border-[#E5E5E5] dark:bg-[#1F1F23] dark:text-white dark:border-[#1F1F1F]"}`}>{m.role === "assistant" && <div className="mb-1 flex items-center gap-1 text-xs font-bold text-[#0D0D0D] dark:text-white"><Bot size={13} /> {t("asistentShoppingAi")}</div>}<p className="whitespace-pre-wrap">{m.content}</p></div>{m.role === "assistant" && <><ProductCarousel title={t("recomandatePentruTine")} products={m.products} />{(m.bundleProducts?.length || 0) > 0 && <div className="mt-3 rounded-2xl border border-[#0D0D0D]/30 dark:border-white/20 bg-gradient-to-br from-[#F0FDF4] to-[#ECFDF5] dark:from-[#0E1F16] dark:to-[#0B1A15] p-4"><div className="flex items-center justify-between mb-3"><p className="text-xs font-black uppercase tracking-widest text-[#0D0D0D] dark:text-white">{t("bundleAiCompleteazaSetul")}</p><p className="text-xs font-bold text-[#6E6E80] dark:text-[#A1A1AA]">{(() => { const bundleTotalPrice = (m.bundleProducts || []).reduce((s, p) => s + p.price, 0); const bundleOldPrice = (m.bundleProducts || []).reduce((s, p) => s + (p.oldPrice || p.price), 0); return bundleOldPrice > bundleTotalPrice ? t("economisestiSuma", { amount: money(Math.round(bundleOldPrice - bundleTotalPrice)) }) : t("totalSuma", { amount: money(Math.round(bundleTotalPrice)) }); })()}</p></div><div className="space-y-2">{(m.bundleProducts || []).map(bp => <div key={bp.id} className="flex items-center gap-3 rounded-xl bg-white/80 dark:bg-[#111113]/80 p-2.5 border border-[#E5E5E5]/50 dark:border-[#1F1F1F]/50"><Image src={bp.images?.[0] || ""} alt="" width={48} height={48} className="h-12 w-12 rounded-lg object-cover shrink-0" /><div className="flex-1 min-w-0"><p className="text-xs font-bold text-[#0D0D0D] dark:text-white truncate">{bp.title}</p><p className="text-xs font-bold text-[#0D0D0D] dark:text-white">{money(bp.price)} {bp.oldPrice > bp.price && <span className="text-[#A1A1AA] line-through ml-1">{money(bp.oldPrice)}</span>}</p></div><button type="button" onClick={() => addToCart(bp)} className="shrink-0 rounded-lg bg-[#0D0D0D] dark:bg-white px-2.5 py-1.5 text-[10px] font-black text-white dark:text-black active:scale-90 transition-transform">{t("cos")}</button></div>)}</div><button type="button" onClick={() => { (m.bundleProducts || []).forEach(bp => addToCart(bp)); setToastMessage(t("totBundleulAdaugat")); setTimeout(() => setToastMessage(""), 2500); }} className="mt-3 w-full rounded-xl bg-[#0D0D0D] dark:bg-white py-3 text-xs font-black text-white dark:text-black active:scale-95 transition-transform"><ShoppingCart size={13} className="inline mr-1.5" />{t("adaugaTotBundleul")} {money(Math.round((m.bundleProducts || []).reduce((s, p) => s + p.price, 0)))}</button></div>}{(m.products?.length || 0) > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{[
                    { label: t("arataAltele"), query: t("promptArataAltceva") },
                    { label: t("maiIeftin"), query: t("promptMaiIeftin") },
                    { label: t("topCalitate"), query: t("promptDoarTopCalitate") },
                    { label: t("maiNoi"), query: t("promptProduseNoi") },
                    { label: t("comparaTop2"), query: t("promptComparaTop2") },
                  ].map(chip => <button type="button" key={chip.label} onClick={() => sendMessage(chip.query)} className="rounded-full bg-white dark:bg-[#111113] border border-[#E5E5E5] dark:border-[#1F1F1F] px-3 py-1.5 text-[11px] font-bold text-[#6E6E80] dark:text-[#A1A1AA] hover:border-[#0D0D0D] dark:hover:border-white hover:text-[#0D0D0D] dark:hover:text-white active:scale-95 transition-all">{chip.label}</button>)}</div>}</>}</div>)}{isLoading && <div className="rounded-xl bg-[#F7F7F8] dark:bg-[#1F1F23] p-3 text-sm font-medium text-[#6E6E80] dark:text-[#A1A1AA] border border-[#E5E5E5] dark:border-[#1F1F1F]">{t("aiAnalizeazaSiCauta")}</div>}{messages.length > 0 && !isLoading && <button type="button" onClick={() => { setMessages([]); try { localStorage.removeItem("aicv_chat"); } catch { } }} className="mx-auto block text-[10px] font-bold text-[#A1A1AA] hover:text-[#6E6E80] dark:hover:text-[#D4D4D8] mt-2">{t("stergeConversatia")}</button>}<div ref={messagesEndRef} /></div></div>}
      {activeTab === "deals" && <div className="px-4 pt-4"><h2 className="mb-3 text-2xl font-black text-[#0D0D0D] dark:text-white">{t("reduceri")}</h2>{dealsLoading ? <p className="py-20 text-center font-medium text-[#6E6E80] dark:text-[#A1A1AA]">{t("seIncarca")}</p> : <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 product-grid">{dealsProducts.map((p) => <ProductCard key={p.id} product={p} />)}</div>}</div>}
      {activeTab === "feed" && <ProductFeed products={feedProducts} onAddToCart={(p, q) => addToCart({
        ...p,
        // FeedProduct (components/ProductFeed.tsx) keeps loose string|number id
        // fields for legacy back-compat; Product (types/product.ts) wants strings.
        video: p.video ?? undefined,
        videoId: p.videoId != null ? String(p.videoId) : undefined,
        video_id: p.video_id != null ? String(p.video_id) : undefined,
      }, q || 1)} onLoadMore={loadMoreFeed} onClose={() => setActiveTab("home")} isLoading={feedLoading} />}
      {activeTab === "cart" && (
        <div className="px-4 pt-4 pb-10">
          <h2 className="mb-4 text-2xl font-black text-[#0D0D0D] dark:text-white">{t("cosulTau")}</h2>
          {cartItems.length === 0 ? <p className="py-20 text-center font-medium text-[#6E6E80] dark:text-[#A1A1AA]">{t("cosulEsteGol")}</p> : (
            <>
              <div className="space-y-3">
                {cartItems.map((item, i) => (
                  <div key={item.product.id} className="flex gap-3 rounded-2xl bg-[#F7F7F8] dark:bg-[#1F1F23] p-3 border border-[#E5E5E5] dark:border-[#1F1F1F]">
                    {item.product.images?.[0] && <Image src={item.product.images[0]} alt="" width={64} height={64} className="h-16 w-16 rounded-xl object-cover" />}
                    <div className="flex-1">
                      <p className="line-clamp-2 text-sm font-bold text-[#0D0D0D] dark:text-white">{item.product.title}</p>
                      <p className="text-xs font-bold text-[#0D0D0D] dark:text-white">{money(item.product.price * item.qty)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => updateQty(i, -1)} className="grid h-8 w-8 place-items-center rounded-full bg-[#E5E5E5] dark:bg-[#3F3F46] font-bold text-[#0D0D0D] dark:text-white hover:bg-[#D1D1D6] dark:hover:bg-[#52525B] active:scale-90 transition-transform">-</button>
                      <span className="w-4 text-center font-bold">{item.qty}</span>
                      <button type="button" onClick={() => updateQty(i, 1)} className="grid h-8 w-8 place-items-center rounded-full bg-[#E5E5E5] dark:bg-[#3F3F46] font-bold text-[#0D0D0D] dark:text-white hover:bg-[#D1D1D6] dark:hover:bg-[#52525B] active:scale-90 transition-transform">+</button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-8 border-t border-[#E5E5E5] dark:border-[#1F1F1F] pt-6">
                <ProductCarousel title={t("adaugaLaOfertaSi")} products={trendingProducts.slice(0, 5)} />
              </div>

              <div className="mt-5 rounded-2xl bg-[#F7F7F8] dark:bg-[#1F1F23] p-4 border border-[#E5E5E5] dark:border-[#1F1F1F]">
                <div className="flex justify-between text-xl font-black">
                  <span>{t("totalLabel")}</span>
                  <span className="text-[#0D0D0D] dark:text-white">{money(cartTotal)}</span>
                </div>
                <button type="button" onClick={submitOrder} disabled={checkoutLoading} className={`mt-4 w-full rounded-xl py-4 font-bold disabled:opacity-50 ${THEME.classes.cartButton} dark:bg-white dark:text-black dark:hover:bg-[#E5E5E5] active:scale-[0.98] transition-transform`}>
                  {checkoutLoading ? t("seProceseaza") : t("finalizeazaComandaSuma", { amount: money(cartTotal) })}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
    {activeTab === "chat" && <div className="fixed z-30 w-full md:max-w-2xl lg:max-w-4xl xl:max-w-6xl left-1/2 -translate-x-1/2 border-t border-[#E5E5E5] dark:border-[#1F1F1F] bg-white/95 dark:bg-black/95 px-3 py-2 backdrop-blur-xl chat-input-bar" onTouchStart={e => e.stopPropagation()} onTouchEnd={e => e.stopPropagation()}><div className={`flex gap-2 rounded-xl p-2 ${THEME.classes.softInput} dark:bg-[#1F1F23] dark:border-[#1F1F1F] dark:focus-within:border-white dark:focus-within:shadow-[0_0_0_1px_#FFFFFF]`}><input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && sendMessage()} className="flex-1 bg-transparent px-2 text-base font-medium text-[#0D0D0D] dark:text-white outline-none placeholder:text-[#A1A1AA]" placeholder={t("scrieCeCauti")} aria-label={t("scrieCeCauti")} /><button type="button" onClick={() => sendMessage()} disabled={!input.trim() || isLoading} className="grid h-11 w-11 place-items-center rounded-xl bg-[#0D0D0D] dark:bg-white text-white dark:text-black disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:outline-none" aria-label={t("trimite")}><Send size={18} /></button></div></div>}
    {upsellProduct && <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30" onClick={() => setUpsellProduct(null)}><div className="w-full max-w-lg rounded-t-[2rem] bg-white dark:bg-[#111113] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}><div className="flex items-start justify-between"><div><p className="text-xs font-bold uppercase tracking-widest text-[#0D0D0D] dark:text-white">{t("completeazaBundleul")}</p><h3 className="text-2xl font-black text-[#0D0D0D] dark:text-white">{t("maiVreiSiAsta")}</h3><p className="mt-1 text-sm font-medium text-[#6E6E80] dark:text-[#A1A1AA]">{t("mergeBineCuCe")}</p></div><button type="button" onClick={() => setUpsellProduct(null)} aria-label={t("inchide2")}><X size={18} /></button></div><div className="mt-4 flex gap-3 rounded-2xl bg-[#F7F7F8] dark:bg-[#1F1F23] p-3 border border-[#E5E5E5] dark:border-[#1F1F1F]">{upsellProduct.images?.[0] && <Image src={upsellProduct.images[0]} alt="" width={96} height={96} className="h-24 w-24 rounded-xl object-cover" />}<div className="flex-1"><p className="line-clamp-2 text-sm font-bold">{upsellProduct.title}</p><p className="mt-1 text-xl font-black text-[#0D0D0D] dark:text-white">{money(upsellProduct.price)}</p><button type="button" onClick={() => { addToCart(upsellProduct); setUpsellProduct(null); }} className={`mt-2 w-full rounded-xl py-2 font-bold ${THEME.classes.cartButton} dark:bg-white dark:text-black dark:hover:bg-[#E5E5E5]`}>{t("adaugaLaBundle")}</button></div></div><button type="button" onClick={() => setUpsellProduct(null)} className="mt-3 w-full rounded-xl bg-[#F7F7F8] dark:bg-[#1F1F23] py-3 font-bold text-[#6E6E80] dark:text-[#A1A1AA]">{t("nuAcum")}</button></div></div>}
    {selectedProduct && <ProductModal product={selectedProduct} onClose={() => setSelectedProduct(null)} onAddToCart={() => addToCart(selectedProduct)} />}{toastMessage && <div className="fixed left-1/2 z-50 -translate-x-1/2 rounded-full bg-[#0D0D0D] dark:bg-white px-5 py-2.5 text-sm font-bold text-white dark:text-black shadow-xl toast-position">{toastMessage}</div>}</div></main>;
}
