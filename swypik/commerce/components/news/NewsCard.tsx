"use client";

import { useFormatter, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Link } from "@/lib/i18n/navigation";
import type { NewsArticleListItem } from "@/lib/news/repository";
import { plainSummary, sourceLabel } from "@/lib/news/text";

/** One story in the /news list: image (if the feed had one), category, title, TL;DR, source + date. */
export default function NewsCard({ article }: { article: NewsArticleListItem }) {
  const t = useTranslations("news");
  const format = useFormatter();
  return (
    <Card padding="none" interactive className="overflow-hidden">
      <Link href={`/news/${article.slug}`} className="flex gap-3 p-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Badge tone="brand" size="sm">{t(`categories.${article.category_slug}`)}</Badge>
          <h2 className="line-clamp-3 text-base font-semibold leading-snug text-fg">{article.title}</h2>
          <p className="line-clamp-2 text-sm text-muted">{plainSummary(article.summary_tldr, 160)}</p>
          <p className="text-xs text-subtle">
            {t("card.via", { source: sourceLabel(article.source_name, article.source_url) })}
            {" · "}
            {format.relativeTime(new Date(article.published_at))}
          </p>
        </div>
        {article.cover_image_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- image host comes from the publisher's feed
          <img src={article.cover_image_url} alt="" loading="lazy" className="h-24 w-24 shrink-0 rounded-control bg-surface-2 object-cover" />
        ) : null}
      </Link>
    </Card>
  );
}
