"use client";

import { useState, useMemo, useRef } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Store, Search, Barcode, Plus, Minus, Trash2, CreditCard, Banknote, CheckCircle2, Printer, RotateCcw, Package } from "lucide-react";
import type { PosProduct } from "@/lib/seller/pos-catalog";
import { openSellerFile } from "@/lib/seller/open-file";

export type { PosProduct };

type CartItem = { product: PosProduct; quantity: number };

type Receipt = {
  saleId: string;
  receiptNumber: string;
  date: string;
  totalCents: number;
  paymentMethod: "cash" | "card";
  changeCents: number | null;
};

type Props = { initialProducts: PosProduct[]; currency: string; vatRatePct: number };

const SALE_ERROR_KEYS: Record<string, string> = {
  unauthorized: "errorUnauthorized",
  rate_limited: "errorRateLimited",
  product_not_found: "errorProductNotFound",
  insufficient_stock: "errorInsufficientStock",
  variant_required: "errorVariantRequired",
  validation_error: "errorValidation",
};

const CASH_SHORTCUTS = [50, 100, 200];

/** Câte bucăți se mai pot adăuga (stoc negestionat = fără limită). */
function canAdd(product: PosProduct, inCart: number): boolean {
  return product.stock == null || inCart < product.stock;
}

export default function PosClient({ initialProducts, currency, vatRatePct }: Props) {
  const t = useTranslations("sellerPos");
  const locale = useLocale();
  const [products, setProducts] = useState<PosProduct[]>(initialProducts);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "card">("cash");
  const [cashGiven, setCashGiven] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastReceipt, setLastReceipt] = useState<Receipt | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredProducts = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        (p.variantTitle && p.variantTitle.toLowerCase().includes(q)) ||
        (p.sku && p.sku.toLowerCase().includes(q)) ||
        (p.category && p.category.toLowerCase().includes(q)),
    );
  }, [products, searchQuery]);

  const qtyInCart = (key: string) => cart.find((i) => i.product.key === key)?.quantity ?? 0;

  const addToCart = (product: PosProduct) => {
    if (!canAdd(product, qtyInCart(product.key))) return;
    setCart((prev) => {
      const existing = prev.find((item) => item.product.key === product.key);
      if (existing) return prev.map((item) => (item.product.key === product.key ? { ...item, quantity: item.quantity + 1 } : item));
      return [...prev, { product, quantity: 1 }];
    });
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && filteredProducts.length === 1) {
      addToCart(filteredProducts[0]);
      setSearchQuery("");
    }
  };

  const updateQuantity = (key: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((item) => {
          if (item.product.key !== key) return item;
          const next = item.quantity + delta;
          if (delta > 0 && !canAdd(item.product, item.quantity)) return item;
          return next > 0 ? { ...item, quantity: next } : null;
        })
        .filter((i): i is CartItem => i !== null),
    );
  };

  const removeFromCart = (key: string) => setCart((prev) => prev.filter((item) => item.product.key !== key));
  const clearCart = () => {
    setCart([]);
    setCashGiven("");
  };

  // Totaluri în cenți întregi; TVA extras din prețul cu TVA inclus (cota standard).
  const totalCents = cart.reduce((acc, item) => acc + item.product.priceCents * item.quantity, 0);
  const subtotalCents = Math.round(totalCents / (1 + vatRatePct / 100));
  const vatCents = totalCents - subtotalCents;
  const cashGivenCents = Math.round((parseFloat(cashGiven) || 0) * 100);
  const changeCents = Math.max(0, cashGivenCents - totalCents);

  const money = useMemo(() => {
    try {
      const f = new Intl.NumberFormat(locale, { style: "currency", currency });
      return (cents: number) => f.format(cents / 100);
    } catch {
      return (cents: number) => `${(cents / 100).toFixed(2)} ${currency}`;
    }
  }, [locale, currency]);
  const timeFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }), [locale]);

  const handleCheckout = async () => {
    if (cart.length === 0) return;
    setIsProcessing(true);
    setError(null);
    try {
      const res = await fetch("/api/seller/pos/sale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: cart.map((item) => ({
            id: item.product.id,
            ...(item.product.variantId ? { variantId: item.product.variantId } : {}),
            quantity: item.quantity,
            price: item.product.priceCents / 100,
          })),
          paymentMethod,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(t(SALE_ERROR_KEYS[data?.error as string] ?? "checkoutError"));
        return;
      }
      setProducts((prev) =>
        prev.map((p) => {
          const inCart = cart.find((item) => item.product.key === p.key);
          return inCart && p.stock != null ? { ...p, stock: Math.max(0, p.stock - inCart.quantity) } : p;
        }),
      );
      setLastReceipt({
        saleId: data.saleId,
        receiptNumber: data.receiptNumber,
        date: timeFormatter.format(new Date(data.date ?? Date.now())),
        totalCents,
        paymentMethod,
        changeCents: paymentMethod === "cash" && cashGivenCents > 0 ? changeCents : null,
      });
      clearCart();
    } catch {
      setError(t("networkError"));
    } finally {
      setIsProcessing(false);
    }
  };

  const printReceipt = async (receipt: Receipt) => {
    setError(null);
    const result = await openSellerFile("pos_receipt", receipt.saleId, `${receipt.receiptNumber}.pdf`);
    if (result === "failed") setError(t("errorFileOpen"));
  };

  const payBtn = (active: boolean) =>
    `py-2 px-3 min-h-[44px] rounded-control border flex items-center justify-center gap-2 text-xs font-bold transition ${
      active ? "bg-fg text-fg-inverse border-fg" : "bg-surface text-fg border-subtle"
    }`;

  return (
    <div className="flex flex-col lg:flex-row gap-6 h-[calc(100dvh-140px)] min-h-[600px]">
      <div className="flex-1 flex flex-col bg-surface border border-subtle rounded-card shadow-elev-1 overflow-hidden">
        <div className="p-4 border-b border-subtle bg-surface-2 flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-3 text-subtle w-4 h-4" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchPlaceholder")}
              className="w-full pl-10 pr-4 py-2.5 bg-surface text-fg border border-subtle rounded-control text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </div>
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted font-bold bg-surface px-3 py-2.5 rounded-control border border-subtle">
            <Barcode className="w-4 h-4 text-brand" />
            {t("scannerActive")}
          </div>
        </div>

        <div className="flex-1 p-4 overflow-y-auto grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3.5 content-start">
          {filteredProducts.map((product) => {
            const isOutOfStock = product.stock != null && product.stock <= 0;
            const label = product.variantTitle ? `${product.title} — ${product.variantTitle}` : product.title;
            return (
              <button
                key={product.key}
                type="button"
                onClick={() => addToCart(product)}
                disabled={isOutOfStock}
                aria-label={t("addToCartAria", { title: label })}
                className="flex flex-col text-left p-3 rounded-control border border-subtle hover:border-brand hover:shadow-elev-2 transition bg-surface group disabled:opacity-50 disabled:pointer-events-none relative"
              >
                <div className="w-full aspect-square rounded-control bg-surface-2 overflow-hidden mb-2.5 relative">
                  {product.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- imagini de produs cu URL arbitrar (R2/AliExpress)
                    <img src={product.imageUrl} alt={label} className="w-full h-full object-cover group-hover:scale-105 transition" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-subtle">
                      <Package className="w-8 h-8" />
                    </div>
                  )}
                  {isOutOfStock ? (
                    <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-danger text-fg-inverse text-xs font-bold uppercase">
                      {t("outOfStock")}
                    </span>
                  ) : product.stock != null ? (
                    <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-overlay/70 text-fg-inverse text-xs font-bold">
                      {t("stockLabel", { count: product.stock })}
                    </span>
                  ) : null}
                </div>
                <div className="flex-1">
                  <h4 className="font-bold text-xs text-fg line-clamp-2 leading-tight mb-1">{product.title}</h4>
                  {product.variantTitle && <p className="text-xs text-muted mb-1">{product.variantTitle}</p>}
                  {product.sku && <p className="text-xs text-subtle font-mono mb-1">{product.sku}</p>}
                </div>
                <div className="pt-2 border-t border-subtle flex items-center justify-between mt-auto">
                  <span className="font-black text-sm text-brand">{money(product.priceCents)}</span>
                  <span className="w-6 h-6 rounded-full bg-surface-2 group-hover:bg-brand group-hover:text-brand-fg flex items-center justify-center text-xs font-bold transition" aria-hidden="true">
                    +
                  </span>
                </div>
              </button>
            );
          })}
          {filteredProducts.length === 0 && (
            <div className="col-span-full py-16 text-center text-subtle text-sm">{t("noProductsFound", { query: searchQuery })}</div>
          )}
        </div>
      </div>

      <div className="w-full lg:w-96 flex flex-col bg-surface border border-subtle rounded-card shadow-elev-1 overflow-hidden">
        <div className="p-4 border-b border-subtle bg-surface-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Store className="w-4 h-4 text-brand" />
            <span className="font-black text-sm text-fg">{t("ticketTitle")}</span>
          </div>
          {cart.length > 0 && (
            <button type="button" onClick={clearCart} className="text-xs font-bold text-danger flex items-center gap-1 min-h-[44px] px-1">
              <RotateCcw className="w-3 h-3" /> {t("clearCart")}
            </button>
          )}
        </div>

        <div className="flex-1 p-4 overflow-y-auto space-y-3 divide-y divide-subtle">
          {cart.map((item) => {
            const label = item.product.variantTitle ? `${item.product.title} — ${item.product.variantTitle}` : item.product.title;
            return (
              <div key={item.product.key} className="pt-2.5 first:pt-0 flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-xs text-fg truncate">{label}</p>
                  <p className="text-xs text-muted">
                    {item.quantity} x {money(item.product.priceCents)}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => updateQuantity(item.product.key, -1)}
                    aria-label={t("decreaseQtyAria", { title: label })}
                    className="w-8 h-8 rounded-control bg-surface-2 hover:opacity-80 flex items-center justify-center text-xs font-bold"
                  >
                    <Minus className="w-3 h-3" />
                  </button>
                  <span className="font-bold text-xs w-5 text-center">{item.quantity}</span>
                  <button
                    type="button"
                    onClick={() => updateQuantity(item.product.key, 1)}
                    disabled={!canAdd(item.product, item.quantity)}
                    aria-label={t("increaseQtyAria", { title: label })}
                    className="w-8 h-8 rounded-control bg-surface-2 hover:opacity-80 flex items-center justify-center text-xs font-bold disabled:opacity-40"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeFromCart(item.product.key)}
                    aria-label={t("removeItemAria", { title: label })}
                    className="text-subtle hover:text-danger ml-1 w-8 h-8 flex items-center justify-center"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
          {cart.length === 0 && <div className="py-20 text-center text-subtle text-xs">{t("emptyCart")}</div>}
        </div>

        <div className="p-4 border-t border-subtle bg-surface-2 space-y-3.5 pb-[max(16px,env(safe-area-inset-bottom))]">
          <div className="space-y-1 text-xs text-muted">
            <div className="flex justify-between">
              <span>{t("taxableBase")}</span>
              <span className="font-semibold">{money(subtotalCents)}</span>
            </div>
            <div className="flex justify-between">
              <span>{t("vat")}</span>
              <span className="font-semibold">{money(vatCents)}</span>
            </div>
            <div className="flex justify-between text-base font-black text-fg pt-1 border-t border-subtle">
              <span>{t("totalDue")}</span>
              <span className="text-brand">{money(totalCents)}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setPaymentMethod("cash")} className={payBtn(paymentMethod === "cash")}>
              <Banknote className="w-4 h-4" /> {t("cash")}
            </button>
            <button type="button" onClick={() => setPaymentMethod("card")} className={payBtn(paymentMethod === "card")}>
              <CreditCard className="w-4 h-4" /> {t("cardPos")}
            </button>
          </div>

          {paymentMethod === "cash" && totalCents > 0 && (
            <div className="space-y-1.5 pt-1">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  step="0.1"
                  value={cashGiven}
                  onChange={(e) => setCashGiven(e.target.value)}
                  placeholder={t("cashGivenPlaceholder")}
                  aria-label={t("cashGivenPlaceholder")}
                  className="w-full px-3 py-1.5 text-xs font-semibold border border-subtle rounded-control bg-surface text-fg"
                />
                {CASH_SHORTCUTS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setCashGiven(String(v))}
                    className="px-2 py-1.5 min-h-[44px] text-xs font-bold bg-surface border border-subtle rounded-control hover:bg-surface-2 shrink-0"
                  >
                    {v}
                  </button>
                ))}
              </div>
              {cashGivenCents > 0 && (
                <div className="text-xs font-bold flex justify-between px-1 text-success">
                  <span>{t("changeDue")}</span>
                  <span>{money(changeCents)}</span>
                </div>
              )}
            </div>
          )}

          {error ? (
            <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-xs text-danger">
              {error}
            </p>
          ) : null}

          <button
            type="button"
            disabled={cart.length === 0 || isProcessing}
            onClick={handleCheckout}
            className="w-full py-3 min-h-[48px] bg-success hover:opacity-90 text-fg-inverse rounded-control font-black text-sm shadow-elev-2 transition disabled:opacity-50 flex items-center justify-center gap-2"
          >
            <CheckCircle2 className="w-5 h-5" />
            {isProcessing ? t("processing") : t("checkoutButton", { amount: money(totalCents) })}
          </button>
        </div>
      </div>

      {lastReceipt && (
        <div className="fixed inset-0 z-overlay flex items-center justify-center p-4 bg-overlay/60 backdrop-blur-sm">
          <div className="bg-surface text-fg rounded-card p-6 max-w-sm w-full max-h-[90dvh] overflow-y-auto shadow-elev-3 space-y-4 text-center">
            <div className="w-12 h-12 rounded-full bg-success-soft text-success flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-lg font-black text-fg">{t("saleComplete")}</h3>
              <p className="text-xs text-muted font-mono mt-0.5">{t("receiptNumber", { number: lastReceipt.receiptNumber })}</p>
            </div>
            <div className="bg-surface-2 p-3 rounded-control text-left text-xs font-mono space-y-1">
              <div className="flex justify-between">
                <span>{t("date")}</span>
                <span>{lastReceipt.date}</span>
              </div>
              <div className="flex justify-between">
                <span>{t("payment")}</span>
                <span className="uppercase">{lastReceipt.paymentMethod === "cash" ? t("cash") : t("cardPos")}</span>
              </div>
              <div className="flex justify-between font-bold pt-1 border-t border-subtle">
                <span>{t("total")}</span>
                <span>{money(lastReceipt.totalCents)}</span>
              </div>
              {lastReceipt.changeCents !== null && (
                <div className="flex justify-between text-success">
                  <span>{t("change")}</span>
                  <span>{money(lastReceipt.changeCents)}</span>
                </div>
              )}
            </div>
            {error ? <p className="text-xs text-danger">{error}</p> : null}
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => printReceipt(lastReceipt)}
                className="flex-1 py-2.5 min-h-[44px] rounded-control border border-subtle font-bold text-xs flex items-center justify-center gap-1.5 hover:bg-surface-2"
              >
                <Printer className="w-4 h-4" /> {t("printReceipt")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setLastReceipt(null);
                  setError(null);
                }}
                className="flex-1 py-2.5 min-h-[44px] rounded-control bg-fg text-fg-inverse font-bold text-xs hover:opacity-90"
              >
                {t("nextSale")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
