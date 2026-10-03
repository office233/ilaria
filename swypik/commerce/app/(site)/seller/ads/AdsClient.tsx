"use client";

import React, { useMemo, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Megaphone, Plus, Play, Pause, TrendingUp, Eye, ShoppingBag, Zap, Target, Info, X } from "lucide-react";
import type { AdType } from "@/lib/seller/ads-config";

type CampaignStatus = "pending_review" | "active" | "paused" | "ended";

export interface Campaign {
  id: string;
  campaign_name: string;
  ad_type: AdType | string;
  product_id?: string | null;
  product_title?: string | null;
  daily_budget_cents: number;
  spent_budget_cents: number;
  target_city: string;
  status: CampaignStatus;
  impressions_count: number;
  clicks_count: number;
  orders_count: number;
  revenue_cents: number;
  created_at: string;
}

export interface ProductOption {
  id: string;
  title: string;
  price_cents: number;
}

type Props = {
  initialCampaigns: Campaign[];
  sellerProducts: ProductOption[];
  currency: string;
  adTypes: readonly AdType[];
  budget: { min: number; max: number; default: number };
  targetCities: readonly string[];
};

const TYPE_KEYS: Record<string, string> = { boost_reel: "typeBoostReel", flash_sale: "typeFlashSale" };
const STATUS_KEYS: Record<CampaignStatus, string> = {
  pending_review: "statusPendingReview",
  active: "statusActive",
  paused: "statusPaused",
  ended: "statusEnded",
};
const STATUS_TONE: Record<CampaignStatus, string> = {
  pending_review: "bg-warning-soft text-warning",
  active: "bg-success-soft text-success",
  paused: "bg-surface-2 text-muted",
  ended: "bg-surface-2 text-subtle",
};
const CITY_KEYS: Record<string, string> = {
  all_ro: "cityAllRo",
  bucuresti: "cityBucuresti",
  cluj: "cityCluj",
  timisoara: "cityTimisoara",
  iasi: "cityIasi",
  brasov: "cityBrasov",
};
const ERROR_KEYS: Record<string, string> = {
  unauthorized: "errorUnauthorized",
  rate_limited: "errorRateLimited",
  validation_error: "errorValidation",
  product_not_owned: "errorProductNotOwned",
};

/**
 * Swypik Ads — încă fără motor de livrare a reclamelor: campaniile noi așteaptă
 * aprobarea (pending_review) și nu se taxează nimic. Pagina o spune explicit.
 */
export default function AdsClient({ initialCampaigns, sellerProducts, currency, adTypes, budget, targetCities }: Props) {
  const t = useTranslations("sellerGrowthAds");
  const locale = useLocale();
  const [campaigns, setCampaigns] = useState<Campaign[]>(initialCampaigns);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [campaignName, setCampaignName] = useState("");
  const [adType, setAdType] = useState<AdType>(adTypes[0]);
  const [selectedProduct, setSelectedProduct] = useState(sellerProducts[0]?.id || "");
  const [dailyBudget, setDailyBudget] = useState(String(budget.default));
  const [targetCity, setTargetCity] = useState(targetCities[0] ?? "all_ro");

  const money = useMemo(() => {
    try {
      const f = new Intl.NumberFormat(locale, { style: "currency", currency });
      return (cents: number) => f.format((Number(cents) || 0) / 100);
    } catch {
      return (cents: number) => `${((Number(cents) || 0) / 100).toFixed(2)} ${currency}`;
    }
  }, [locale, currency]);

  const totalSpentCents = campaigns.reduce((acc, c) => acc + (Number(c.spent_budget_cents) || 0), 0);
  const totalRevenueCents = campaigns.reduce((acc, c) => acc + (Number(c.revenue_cents) || 0), 0);
  const totalImpressions = campaigns.reduce((acc, c) => acc + (Number(c.impressions_count) || 0), 0);
  const totalOrders = campaigns.reduce((acc, c) => acc + (Number(c.orders_count) || 0), 0);
  const roas = totalSpentCents > 0 ? (totalRevenueCents / totalSpentCents).toFixed(2) : "0.00";

  const handleToggle = async (id: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/seller/ads/${id}/toggle`, { method: "PATCH" });
      const data = await res.json().catch(() => null);
      if (data?.success) {
        setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, status: data.campaign.status } : c)));
      } else {
        setError(t("errorToggle"));
      }
    } catch {
      setError(t("errorToggle"));
    }
  };

  const handleCreateCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!campaignName.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/seller/ads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaignName,
          adType,
          ...(selectedProduct ? { productId: selectedProduct } : {}),
          dailyBudgetRon: parseFloat(dailyBudget) || budget.default,
          targetCity,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(t(ERROR_KEYS[data?.error as string] ?? "errorCreate"));
        return;
      }
      const prod = sellerProducts.find((p) => p.id === selectedProduct);
      setCampaigns((prev) => [
        {
          id: data.campaign.id,
          campaign_name: data.campaign.campaign_name,
          ad_type: data.campaign.ad_type,
          product_id: selectedProduct || null,
          product_title: prod?.title ?? null,
          daily_budget_cents: Number(data.campaign.daily_budget_cents),
          spent_budget_cents: 0,
          target_city: targetCity,
          status: data.campaign.status as CampaignStatus,
          impressions_count: 0,
          clicks_count: 0,
          orders_count: 0,
          revenue_cents: 0,
          created_at: data.campaign.created_at,
        },
        ...prev,
      ]);
      setIsModalOpen(false);
      setCampaignName("");
      setDailyBudget(String(budget.default));
    } catch {
      setError(t("errorNetwork"));
    } finally {
      setSubmitting(false);
    }
  };

  const stat = (icon: React.ReactNode, label: string, value: string, hint: string) => (
    <div className="bg-surface border border-subtle rounded-card p-4 shadow-elev-1">
      <div className="flex items-center gap-2 text-muted">
        {icon}
        <span className="text-xs font-bold uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-2xl font-black text-fg mt-1">{value}</p>
      <p className="text-xs text-subtle mt-1 font-medium">{hint}</p>
    </div>
  );

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black text-fg tracking-tight">{t("pageTitle")}</h1>
          <p className="text-sm text-muted mt-1">{t("pageSubtitle")}</p>
        </div>
        <button
          type="button"
          onClick={() => setIsModalOpen(true)}
          className="inline-flex items-center justify-center gap-2 bg-fg text-fg-inverse hover:opacity-90 px-5 py-2.5 min-h-[44px] rounded-control font-bold text-sm shadow-elev-1 transition"
        >
          <Plus size={16} /> {t("createCampaign")}
        </button>
      </div>

      <div role="note" className="flex items-start gap-2 rounded-card border border-info/30 bg-info-soft p-4 text-sm text-fg">
        <Info className="h-4 w-4 text-info shrink-0 mt-0.5" />
        <p>{t("previewNotice")}</p>
      </div>

      {error ? (
        <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stat(<TrendingUp size={16} />, t("avgRoas"), `${roas}x`, t("roasHint"))}
        {stat(<Eye size={16} />, t("totalImpressions"), totalImpressions.toLocaleString(locale), t("impressionsHint"))}
        {stat(<ShoppingBag size={16} />, t("ordersGenerated"), totalOrders.toLocaleString(locale), t("directConversions"))}
        {stat(<Megaphone size={16} />, t("budgetSpent"), money(totalSpentCents), `${t("revenueGenerated")}: ${money(totalRevenueCents)}`)}
      </div>

      <div className="bg-surface border border-subtle rounded-card shadow-elev-1 overflow-hidden">
        <div className="p-4 border-b border-subtle flex items-center justify-between">
          <h2 className="text-sm font-black text-fg uppercase tracking-wider">{t("campaignsHistory")}</h2>
          <span className="text-xs text-subtle font-medium">{t("campaignCount", { count: campaigns.length })}</span>
        </div>

        {campaigns.length === 0 ? (
          <div className="p-10 text-center">
            <Megaphone className="w-10 h-10 text-subtle mx-auto mb-3" />
            <p className="text-sm font-bold text-fg">{t("emptyTitle")}</p>
            <p className="text-xs text-muted mt-1 max-w-sm mx-auto">{t("emptySubtitle")}</p>
            <button
              type="button"
              onClick={() => setIsModalOpen(true)}
              className="mt-4 inline-flex items-center gap-2 bg-brand text-brand-fg hover:bg-brand-hover px-4 py-2 min-h-[44px] rounded-control font-bold text-xs"
            >
              {t("launchFirstCampaign")}
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-2 text-muted font-bold uppercase tracking-wider">
                <tr>
                  <th className="p-3.5">{t("colCampaign")}</th>
                  <th className="p-3.5">{t("colType")}</th>
                  <th className="p-3.5">{t("colDailyBudget")}</th>
                  <th className="p-3.5">{t("colImpressions")}</th>
                  <th className="p-3.5">{t("colOrders")}</th>
                  <th className="p-3.5">{t("colStatus")}</th>
                  <th className="p-3.5 text-right">{t("colActions")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-subtle">
                {campaigns.map((c) => {
                  const toggleable = c.status === "active" || c.status === "paused";
                  return (
                    <tr key={c.id} className="hover:bg-surface-2">
                      <td className="p-3.5 font-bold text-fg">
                        <div>{c.campaign_name}</div>
                        {c.product_title && <div className="text-xs text-subtle font-medium">{c.product_title}</div>}
                      </td>
                      <td className="p-3.5">
                        <span className="inline-flex items-center gap-1 font-semibold text-fg">
                          {c.ad_type === "flash_sale" ? <Target size={13} className="text-danger" /> : <Zap size={13} className="text-warning" />}
                          {t(TYPE_KEYS[c.ad_type] ?? "typeOther")}
                        </span>
                      </td>
                      <td className="p-3.5 font-semibold text-fg">{t("perDay", { amount: money(c.daily_budget_cents) })}</td>
                      <td className="p-3.5 font-semibold">{c.impressions_count || 0}</td>
                      <td className="p-3.5 font-semibold text-success">{c.orders_count || 0}</td>
                      <td className="p-3.5">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-black uppercase ${STATUS_TONE[c.status] ?? STATUS_TONE.paused}`}>
                          {t(STATUS_KEYS[c.status] ?? "statusPaused")}
                        </span>
                      </td>
                      <td className="p-3.5 text-right">
                        {toggleable ? (
                          <button
                            type="button"
                            onClick={() => handleToggle(c.id)}
                            className="hit-target-44 rounded-control border border-subtle hover:bg-surface-2 text-muted transition"
                            title={c.status === "active" ? t("pauseAction") : t("resumeAction")}
                            aria-label={c.status === "active" ? t("pauseAction") : t("resumeAction")}
                          >
                            {c.status === "active" ? <Pause size={14} /> : <Play size={14} />}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-overlay flex items-center justify-center p-4 bg-overlay/60 backdrop-blur-sm">
          <div className="bg-surface text-fg rounded-card p-6 max-w-lg w-full shadow-elev-3 space-y-4 max-h-[90dvh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-subtle pb-3">
              <h3 className="text-base font-black text-fg">{t("modalTitle")}</h3>
              <button type="button" onClick={() => setIsModalOpen(false)} aria-label={t("close")} className="hit-target-44 text-subtle hover:text-fg">
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleCreateCampaign} className="space-y-4">
              <div>
                <label htmlFor="ad-name" className="block text-xs font-bold text-fg uppercase tracking-wider mb-1">
                  {t("campaignNameLabel")}
                </label>
                <input
                  id="ad-name"
                  type="text"
                  required
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  placeholder={t("campaignNamePlaceholder")}
                  className="w-full px-3 py-2 border border-subtle bg-surface rounded-control text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand"
                />
              </div>

              <div>
                <p className="block text-xs font-bold text-fg uppercase tracking-wider mb-1">{t("promoTypeLabel")}</p>
                <div className="grid grid-cols-2 gap-2">
                  {adTypes.map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setAdType(type)}
                      className={`py-2 px-3 min-h-[44px] rounded-control border text-xs font-bold transition ${
                        adType === type ? "bg-brand-soft border-brand text-brand-soft-fg" : "bg-surface border-subtle text-muted"
                      }`}
                    >
                      {t(TYPE_KEYS[type] ?? "typeOther")}
                    </button>
                  ))}
                </div>
              </div>

              {sellerProducts.length > 0 && (
                <div>
                  <label htmlFor="ad-product" className="block text-xs font-bold text-fg uppercase tracking-wider mb-1">
                    {t("promotedProductLabel")}
                  </label>
                  <select
                    id="ad-product"
                    value={selectedProduct}
                    onChange={(e) => setSelectedProduct(e.target.value)}
                    className="w-full px-3 py-2 border border-subtle bg-surface rounded-control text-sm font-semibold"
                  >
                    {sellerProducts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title} — {money(p.price_cents)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="ad-budget" className="block text-xs font-bold text-fg uppercase tracking-wider mb-1">
                    {t("dailyBudgetLabel", { currency })}
                  </label>
                  <input
                    id="ad-budget"
                    type="number"
                    min={budget.min}
                    max={budget.max}
                    value={dailyBudget}
                    onChange={(e) => setDailyBudget(e.target.value)}
                    className="w-full px-3 py-2 border border-subtle bg-surface rounded-control text-sm font-semibold"
                  />
                  <span className="text-xs text-subtle mt-0.5 block">{t("minPerDay", { amount: money(budget.min * 100) })}</span>
                </div>
                <div>
                  <label htmlFor="ad-city" className="block text-xs font-bold text-fg uppercase tracking-wider mb-1">
                    {t("geoTargetLabel")}
                  </label>
                  <select
                    id="ad-city"
                    value={targetCity}
                    onChange={(e) => setTargetCity(e.target.value)}
                    className="w-full px-3 py-2 border border-subtle bg-surface rounded-control text-sm font-semibold"
                  >
                    {targetCities.map((city) => (
                      <option key={city} value={city}>
                        {CITY_KEYS[city] ? t(CITY_KEYS[city]) : city}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setIsModalOpen(false)} className="px-4 py-2 min-h-[44px] rounded-control border border-subtle text-xs font-bold hover:bg-surface-2">
                  {t("cancel")}
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 min-h-[44px] rounded-control bg-brand hover:bg-brand-hover text-brand-fg text-xs font-bold disabled:opacity-50"
                >
                  {submitting ? t("launching") : t("activateCampaign")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
