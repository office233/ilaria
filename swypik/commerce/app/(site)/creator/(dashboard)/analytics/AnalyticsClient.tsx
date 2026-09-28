"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useLocale, useTranslations } from "next-intl";
import { formatCurrency } from "@/lib/i18n/currency";
import type { Currency, Locale } from "@/lib/i18n/config";
import { useFormatPrice } from "@/components/i18n/useFormatPrice";

// recharts (~107 kB gz) se incarca doar cand graficul chiar se randeaza.
const TrendChart = dynamic(() => import("./TrendChart"), {
  ssr: false,
  loading: () => <div className="h-64 rounded-xl bg-surface-2 animate-pulse" />,
});

type Range = "7d" | "30d" | "90d" | "all";

interface AnalyticsData {
  range: Range;
  summary: {
    totalViews: number; totalLikes: number; totalComments: number;
    totalShares: number; totalSaves: number; totalEarningsCents: number;
    earningsCurrency: string; videosPublished: number;
    avgCompletionRate: number; conversionRate: number; followersGained: number;
    productCtr: number; productClicks: number;
    attributedSalesCents: number; attributedOrders: number;
    creatorFundCents: number;
  };
  topVideos: Array<{
    id: string; title: string; thumbnail: string | null;
    views: number; likes: number; earningsCents: number;
  }>;
  viewsOverTime: Array<{ date: string; views: number }>;
  earningsOverTime: Array<{ date: string; cents: number }>;
  audienceTopCountries: Array<{ country: string; percentage: number }>;
  audienceAgeBuckets: Array<{ bucket: string; percentage: number }>;
}

type SortKey = "views" | "likes" | "earnings";

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface border border-subtle rounded-2xl p-5 flex flex-col gap-1">
      <span className="text-xs font-bold text-muted uppercase tracking-wide">{label}</span>
      <span className="text-3xl font-bold text-fg tabular-nums">{value}</span>
    </div>
  );
}

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse bg-surface-2 rounded-xl ${className ?? ""}`} />;
}

export default function AnalyticsClient() {
  const t = useTranslations("creatorAnalytics");
  const locale = useLocale() as Locale;
  const formatNumber = (n: number): string => new Intl.NumberFormat(locale).format(n);
  const RANGES: { value: Range; label: string }[] = [
    { value: "7d", label: t("range7d") },
    { value: "30d", label: t("range30d") },
    { value: "90d", label: t("range90d") },
    { value: "all", label: t("rangeAll") },
  ];
  const [range, setRange] = useState<Range>("30d");
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("views");
  const fmt = useFormatPrice();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/creator/analytics?range=${range}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json: AnalyticsData) => { if (!cancelled) setData(json); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [range]);

  const sortedTop = useMemo(() => {
    if (!data) return [];
    const arr = [...data.topVideos];
    arr.sort((a, b) => {
      if (sortKey === "views") return b.views - a.views;
      if (sortKey === "likes") return b.likes - a.likes;
      return b.earningsCents - a.earningsCents;
    });
    return arr;
  }, [data, sortKey]);

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black text-fg">{t("pageTitle")}</h1>
          <p className="text-sm text-muted mt-1">{t("pageSubtitle")}</p>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1 snap-x">
          {RANGES.map((r) => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className={`px-4 py-2 rounded-full text-sm font-bold whitespace-nowrap snap-start transition ${range === r.value ? "bg-fg text-fg-inverse" : "bg-surface text-fg border border-subtle hover:bg-surface-2"
                }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="bg-danger-soft border border-danger/30 text-danger rounded-xl p-4 text-sm">
          {t("errorLoading")}: {error}
        </div>
      )}

      {loading || !data ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (<Skeleton key={i} className="h-28" />))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <MetricCard label={t("metricViews")} value={formatNumber(data.summary.totalViews)} />
          <MetricCard label={t("metricLikes")} value={formatNumber(data.summary.totalLikes)} />
          <MetricCard label={t("metricComments")} value={formatNumber(data.summary.totalComments)} />
          <MetricCard label={t("metricShares")} value={formatNumber(data.summary.totalShares)} />
          <MetricCard
            label={t("metricEarnings")}
            value={fmt(data.summary.totalEarningsCents, { sourceCurrency: data.summary.earningsCurrency as Currency })}
          />
          <MetricCard label={t("metricNewFollowers")} value={formatNumber(data.summary.followersGained)} />
        </div>
      )}

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard label={t("metricVideosPublished")} value={formatNumber(data.summary.videosPublished)} />
          <MetricCard label={t("metricCompletionRate")} value={`${(data.summary.avgCompletionRate * 100).toFixed(1)}%`} />
          <MetricCard label={t("metricConversionRate")} value={`${(data.summary.conversionRate * 100).toFixed(2)}%`} />
          <MetricCard label={t("metricSaves")} value={formatNumber(data.summary.totalSaves)} />
        </div>
      )}

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <MetricCard label={t("metricProductCtr")} value={`${((data.summary.productCtr ?? 0) * 100).toFixed(2)}%`} />
          <MetricCard label={t("metricProductClicks")} value={formatNumber(data.summary.productClicks ?? 0)} />
          <MetricCard
            label={t("metricAttributedSales")}
            value={fmt(data.summary.attributedSalesCents ?? 0, { sourceCurrency: data.summary.earningsCurrency as Currency })}
          />
          <MetricCard
            label={t("metricCreatorFund")}
            value={fmt(data.summary.creatorFundCents ?? 0, { sourceCurrency: data.summary.earningsCurrency as Currency })}
          />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface border border-subtle rounded-2xl p-5">
          <h3 className="text-sm font-black text-fg mb-4">{t("chartViewsOverTime")}</h3>
          {loading || !data ? (
            <Skeleton className="h-64" />
          ) : data.viewsOverTime.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-sm text-muted">
              {t("noViewEvents")}
            </div>
          ) : (
            <TrendChart data={data.viewsOverTime} dataKey="views" stroke="rgb(var(--fg))" />
          )}
        </div>

        <div className="bg-surface border border-subtle rounded-2xl p-5">
          <h3 className="text-sm font-black text-fg mb-4">{t("chartEarningsOverTime")}</h3>
          {loading || !data ? (
            <Skeleton className="h-64" />
          ) : data.earningsOverTime.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-sm text-muted">
              {t("noApprovedCommission")}
            </div>
          ) : (
            <TrendChart
              data={data.earningsOverTime}
              dataKey="cents"
              stroke="rgb(var(--success))"
              formatValue={(value) =>
                formatCurrency(value, { sourceCurrency: (data.summary.earningsCurrency || "RON") as Currency })
              }
            />
          )}
        </div>
      </div>

      <div className="bg-surface border border-subtle rounded-2xl p-5">
        <h3 className="text-sm font-black text-fg mb-4">{t("topVideosTitle")}</h3>
        {loading || !data ? (
          <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => (<Skeleton key={i} className="h-14" />))}</div>
        ) : sortedTop.length === 0 ? (
          <p className="text-sm text-muted py-8 text-center">{t("noVideosThisPeriod")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-subtle">
                  <th className="py-2 pr-2 font-bold text-muted">{t("colClip")}</th>
                  <th className={`py-2 px-2 font-bold cursor-pointer ${sortKey === "views" ? "text-fg" : "text-muted"}`} onClick={() => setSortKey("views")}>{t("colViews")}</th>
                  <th className={`py-2 px-2 font-bold cursor-pointer ${sortKey === "likes" ? "text-fg" : "text-muted"}`} onClick={() => setSortKey("likes")}>{t("colLikes")}</th>
                  <th className={`py-2 px-2 font-bold cursor-pointer text-right ${sortKey === "earnings" ? "text-fg" : "text-muted"}`} onClick={() => setSortKey("earnings")}>{t("colEarnings")}</th>
                </tr>
              </thead>
              <tbody>
                {sortedTop.map((v) => (
                  <tr key={v.id} className="border-b border-subtle hover:bg-surface-2 cursor-pointer">
                    <td className="py-2 pr-2">
                      <Link href={`/video/${v.id}`} className="flex items-center gap-3">
                        {v.thumbnail ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={v.thumbnail} alt="" className="w-12 h-16 object-cover rounded-md bg-surface-2" />
                        ) : (
                          <div className="w-12 h-16 rounded-md bg-surface-2" />
                        )}
                        <span className="font-bold text-fg line-clamp-2">{v.title || t("noTitle")}</span>
                      </Link>
                    </td>
                    <td className="py-2 px-2 tabular-nums">{formatNumber(v.views)}</td>
                    <td className="py-2 px-2 tabular-nums">{formatNumber(v.likes)}</td>
                    <td className="py-2 px-2 tabular-nums text-right">
                      {fmt(v.earningsCents, { sourceCurrency: (data.summary.earningsCurrency || "RON") as Currency })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface border border-subtle rounded-2xl p-5">
          <h3 className="text-sm font-black text-fg mb-4">{t("topCountriesTitle")}</h3>
          {!data || data.audienceTopCountries.length === 0 ? (
            <p className="text-sm text-muted py-8 text-center">
              {t("noCountryData")}
            </p>
          ) : (
            <ul className="space-y-2">
              {data.audienceTopCountries.map((c) => (
                <li key={c.country} className="flex items-center justify-between text-sm">
                  <span className="font-bold text-fg">{c.country}</span>
                  <span className="text-muted tabular-nums">{c.percentage}%</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="bg-surface border border-subtle rounded-2xl p-5">
          <h3 className="text-sm font-black text-fg mb-4">{t("ageTitle")}</h3>
          {!data || data.audienceAgeBuckets.length === 0 ? (
            <p className="text-sm text-muted py-8 text-center">
              {t("noAgeData")}
            </p>
          ) : (
            <ul className="space-y-2">
              {data.audienceAgeBuckets.map((b) => (
                <li key={b.bucket} className="flex items-center justify-between text-sm">
                  <span className="font-bold text-fg">{b.bucket}</span>
                  <span className="text-muted tabular-nums">{b.percentage}%</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
