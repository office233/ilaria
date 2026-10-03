"use client";

import { useState, useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoneyCents } from "@/lib/i18n/currency";
import { isLocale, DEFAULT_LOCALE } from "@/lib/i18n/config";
import { logger } from "@/lib/logger";
import {
  Sparkles,
  X,
  Plus,
  CheckCircle2,
  Film,
  ShieldCheck,
  Truck,
} from "lucide-react";

type ViralProduct = {
  id: string;
  title: string;
  description: string;
  category: string;
  wholesaleCostRon: number;
  recommendedPriceRon: number;
  imageUrl: string;
  videoUrl: string;
  sku: string;
  barcode: string;
  rating: number;
  ordersCount: number;
};

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onProductImported: () => void;
};

export default function ViralCatalogModal({ isOpen, onClose, onProductImported }: Props) {
  const t = useTranslations("sellerGrowthViralCatalog");
  const [products, setProducts] = useState<ViralProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const rawLocale = useLocale();
  const locale = isLocale(rawLocale) ? rawLocale : DEFAULT_LOCALE;
  // Catalogul demo e în RON (câmpurile *Ron); formatarea urmează limba utilizatorului.
  const money = (ron: number) => formatMoneyCents(Math.round(ron * 100), "RON", locale);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setUnavailable(false);
    fetch("/api/seller/catalog/viral-products")
      .then(async (res) => {
        if (!res.ok) {
          setUnavailable(true);
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (data.success && Array.isArray(data.products)) setProducts(data.products);
        else setUnavailable(true);
      })
      .catch((err) => {
        logger.error({ err }, "Failed to load viral catalog");
        setUnavailable(true);
      })
      .finally(() => setLoading(false));
  }, [isOpen]);

  const handleImport = async (product: ViralProduct) => {
    setImportingId(product.id);
    try {
      const res = await fetch("/api/seller/catalog/import-viral", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ viralId: product.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        alert(data.error || t("errorImport"));
        return;
      }
      setImportedIds((prev) => new Set([...prev, product.id]));
      onProductImported();
    } catch (err) {
      logger.error({ err }, "Failed to import viral product");
      alert(t("errorNetwork"));
    } finally {
      setImportingId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/60 backdrop-blur-sm">
      <div className="bg-white rounded-3xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="p-5 sm:p-6 border-b border-[#E5E5E5] bg-gradient-to-r from-violet-50 to-indigo-50/40 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-violet-600" />
              <h2 className="text-xl font-black text-[#0D0D0D]">
                {t("headerTitle")}
              </h2>
              <span className="px-2.5 py-0.5 rounded-full text-xs font-black bg-violet-600 text-white uppercase tracking-wider">
                {t("headerBadge")}
              </span>
            </div>
            <p className="text-xs text-neutral-600 mt-1 max-w-2xl">
              {t.rich("headerSubtitle", { strong: (chunks) => <strong>{chunks}</strong> })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close")}
            className="p-2 rounded-xl text-neutral-400 hover:text-neutral-700 hover:bg-white/80 transition"
          >
            <X size={22} />
          </button>
        </div>

        {/* Benefits banner */}
        <div className="bg-[#F7F7F8] px-6 py-2.5 border-b border-[#E5E5E5] flex flex-wrap items-center justify-between gap-4 text-xs font-semibold text-neutral-600">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-emerald-600" /> {t("benefitStock")}
          </div>
          <div className="flex items-center gap-1.5">
            <Film className="w-4 h-4 text-violet-600" /> {t("benefitVideo")}
          </div>
          <div className="flex items-center gap-1.5">
            <Truck className="w-4 h-4 text-blue-600" /> {t("benefitShipping")}
          </div>
        </div>

        {/* Products Grid */}
        <div className="flex-1 p-5 sm:p-6 overflow-y-auto">
          {loading ? (
            <div className="py-20 text-center text-neutral-400 text-sm font-medium">
              {t("loadingCatalog")}
            </div>
          ) : unavailable ? (
            <div className="py-20 text-center text-neutral-500 text-sm font-medium">
              {t("catalogUnavailable")}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {products.map((product) => {
                const isImported = importedIds.has(product.id);
                const isImporting = importingId === product.id;
                const profitRon = (product.recommendedPriceRon - product.wholesaleCostRon).toFixed(2);

                return (
                  <div
                    key={product.id}
                    className="border border-[#E5E5E5] rounded-2xl p-4 bg-white flex flex-col hover:border-violet-400 hover:shadow-lg transition space-y-3"
                  >
                    <div className="relative aspect-video rounded-xl overflow-hidden bg-neutral-100">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={product.imageUrl}
                        alt={product.title}
                        className="w-full h-full object-cover"
                      />
                      <span className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/70 text-white text-[10px] font-bold flex items-center gap-1">
                        <Film size={11} className="text-violet-400" /> {t("videoIncluded")}
                      </span>
                      <span className="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-emerald-600 text-white text-[10px] font-black">
                        {t("profitBadge", { amount: profitRon })}
                      </span>
                    </div>

                    <div className="flex-1 min-w-0">
                      <span className="text-[10px] font-bold text-violet-600 uppercase tracking-wider">
                        {product.category}
                      </span>
                      <h3 className="font-bold text-sm text-[#0D0D0D] line-clamp-2 leading-tight mt-0.5">
                        {product.title}
                      </h3>
                      <p className="text-xs text-neutral-500 line-clamp-2 mt-1">
                        {product.description}
                      </p>
                    </div>

                    {/* Price and Profit stats */}
                    <div className="pt-2 border-t border-neutral-100 grid grid-cols-2 gap-2 text-xs">
                      <div className="bg-[#F7F7F8] p-2 rounded-xl">
                        <span className="text-neutral-500 text-[10px] block font-bold">{t("wholesaleCost")}</span>
                        <span className="font-bold text-[#0D0D0D]">{money(product.wholesaleCostRon)}</span>
                      </div>
                      <div className="bg-emerald-50 p-2 rounded-xl text-emerald-800">
                        <span className="text-emerald-700 text-[10px] block font-bold">{t("recommendedPrice")}</span>
                        <span className="font-black">{money(product.recommendedPriceRon)}</span>
                      </div>
                    </div>

                    {/* Action button */}
                    <button
                      type="button"
                      disabled={isImported || isImporting}
                      onClick={() => handleImport(product)}
                      className={`w-full py-2.5 px-4 rounded-xl text-xs font-black transition flex items-center justify-center gap-2 ${
                        isImported
                          ? "bg-emerald-100 text-emerald-700 border border-emerald-300"
                          : "bg-[#0D0D0D] hover:bg-violet-700 text-white shadow-sm"
                      }`}
                    >
                      {isImported ? (
                        <>
                          <CheckCircle2 size={15} /> {t("addedToStore")}
                        </>
                      ) : isImporting ? (
                        t("adding")
                      ) : (
                        <>
                          <Plus size={15} /> {t("addToMyStore")}
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
