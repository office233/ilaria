"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { BadgeCheck, MessageSquare, PenLine } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Select } from "@/components/ui/Select";
import { REVIEW_SORTS, type ReviewSort } from "@/lib/shop/schemas";
import type { ReviewEligibility, ReviewItem, ReviewSummary } from "@/lib/shop/reviews";
import { Stars } from "../Stars";
import { ReviewFormSheet } from "./ReviewFormSheet";

type Props = {
  productId: string;
  productTitle: string;
  summary: ReviewSummary;
  initialItems: ReviewItem[];
  initialHasMore: boolean;
  eligibility: ReviewEligibility;
  pageSize: number;
};

/** Rezumat (medie + distribuție) + listă sortabilă cu „încarcă mai multe” + formular pentru cumpărători. */
export function ReviewsSection({ productId, productTitle, summary, initialItems, initialHasMore, eligibility, pageSize }: Props) {
  const t = useTranslations("shopBuyer.reviews");
  const format = useFormatter();
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [sort, setSort] = useState<ReviewSort>("recent");
  const [loading, setLoading] = useState(false);

  const load = async (nextSort: ReviewSort, offset: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/products/${productId}/reviews?sort=${nextSort}&offset=${offset}&limit=${pageSize}`);
      if (!res.ok) return;
      const data = (await res.json()) as { items: ReviewItem[]; hasMore: boolean };
      setItems((prev) => (offset === 0 ? data.items : [...prev, ...data.items]));
      setHasMore(data.hasMore);
    } finally {
      setLoading(false);
    }
  };

  const writeButton = eligibility.canReview ? (
    <ReviewFormSheet
      productId={productId}
      productTitle={productTitle}
      onSubmitted={() => router.refresh()}
      trigger={
        <Button variant="secondary">
          <PenLine aria-hidden className="h-4 w-4" />
          {t("write")}
        </Button>
      }
    />
  ) : null;

  const footnote = eligibility.alreadyReviewed ? t("alreadyReviewed") : eligibility.canReview ? null : t("onlyBuyers");

  if (summary.total === 0) {
    return (
      <EmptyState
        icon={MessageSquare}
        title={t("noReviews")}
        description={footnote ?? undefined}
        action={writeButton ?? undefined}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-5">
        <div className="text-center">
          <p className="text-4xl font-semibold tabular-nums text-fg">{format.number(summary.average ?? 0, { maximumFractionDigits: 1 })}</p>
          <Stars value={summary.average ?? 0} label={t("starsAria", { value: summary.average ?? 0 })} />
          <p className="mt-1 text-xs text-muted">{t("basedOn", { count: summary.total })}</p>
        </div>
        <ul className="flex-1 space-y-1" aria-label={t("distribution")}>
          {[5, 4, 3, 2, 1].map((stars) => {
            const count = summary.distribution[stars - 1];
            const pct = summary.total ? Math.round((count / summary.total) * 100) : 0;
            return (
              <li key={stars} className="flex items-center gap-2 text-xs text-muted" aria-label={t("distributionRow", { stars, count })}>
                <span className="w-3 tabular-nums">{stars}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                  <span className="block h-full rounded-full bg-warning" style={{ width: `${pct}%` }} />
                </span>
                <span className="w-6 text-right tabular-nums">{count}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="w-48">
          <label htmlFor="review-sort" className="sr-only">
            {t("sortLabel")}
          </label>
          <Select
            id="review-sort"
            value={sort}
            onChange={(e) => {
              const next = e.target.value as ReviewSort;
              setSort(next);
              void load(next, 0);
            }}
            options={REVIEW_SORTS.map((s) => ({ value: s, label: t(`sort_${s}`) }))}
          />
        </div>
        {writeButton}
      </div>
      {footnote ? <p className="text-xs text-muted">{footnote}</p> : null}

      <ul className="divide-y divide-subtle">
        {items.map((r) => (
          <li key={r.id} className="space-y-1 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <Stars value={r.rating} size="sm" label={t("starsAria", { value: r.rating })} />
              <span className="text-sm font-medium text-fg">{r.author || t("anonymous")}</span>
              {r.isVerifiedPurchase ? (
                <Badge tone="success" size="sm">
                  <BadgeCheck aria-hidden className="h-3 w-3" />
                  {t("verified")}
                </Badge>
              ) : null}
            </div>
            {r.title ? <p className="text-sm font-semibold text-fg">{r.title}</p> : null}
            {r.body ? <p className="whitespace-pre-line text-sm text-muted">{r.body}</p> : null}
            <p className="text-xs text-subtle">
              {format.dateTime(new Date(r.createdAt), { dateStyle: "medium" })}
              {r.helpfulCount > 0 ? ` · ${t("helpful", { count: r.helpfulCount })}` : ""}
            </p>
          </li>
        ))}
      </ul>
      {hasMore ? (
        <Button variant="secondary" block loading={loading} onClick={() => void load(sort, items.length)}>
          {t("loadMore")}
        </Button>
      ) : null}
    </div>
  );
}
