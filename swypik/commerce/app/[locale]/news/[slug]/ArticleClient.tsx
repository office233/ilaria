"use client";

import { useFormatter, useTranslations } from "next-intl";
import { ExternalLink, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import ArticleComments from "@/components/news/ArticleComments";
import ArticleReactions from "@/components/news/ArticleReactions";
import ShareButton from "@/components/news/ShareButton";
import { renderNewsMarkdown } from "@/lib/news/markdown";
import type { NewsArticleDetail } from "@/lib/news/repository";
import { sourceLabel } from "@/lib/news/text";

/** Article reader: TL;DR, the original source (always shown, always linked), AI summary body, reactions, comments. */
export default function ArticleClient({ article }: { article: NewsArticleDetail }) {
  const t = useTranslations("news");
  const format = useFormatter();
  const primarySource = sourceLabel(article.source_name, article.source_url);

  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader back="/news" title={t(`categories.${article.category_slug}`)} actions={<ShareButton title={article.title} />} />
      <article className="mx-auto max-w-2xl space-y-5 px-gutter py-4">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-subtle">
            <Badge tone="brand" size="sm">{t(`categories.${article.category_slug}`)}</Badge>
            <span>{format.dateTime(new Date(article.published_at), { day: "numeric", month: "long", year: "numeric" })}</span>
            <span aria-hidden>·</span>
            <span>{t("readMinutes", { minutes: article.reading_time_minutes })}</span>
          </div>
          <h1 className="text-2xl font-bold leading-tight text-fg">{article.title}</h1>
          <p className="text-sm text-muted">{t("card.via", { source: primarySource })}</p>
        </header>

        {article.cover_image_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- image host comes from the publisher's feed
          <img src={article.cover_image_url} alt="" className="aspect-video w-full rounded-card bg-surface-2 object-cover" />
        ) : null}

        <Card variant="muted" className="space-y-2">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-brand">
            <Sparkles className="h-4 w-4" aria-hidden /> {t("article.tldr")}
          </p>
          <p className="whitespace-pre-line text-sm leading-relaxed text-fg">{article.summary_tldr}</p>
        </Card>

        <Card className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{t("source.label")}</p>
          <ul className="space-y-1">
            {article.sources.map((s) => (
              <li key={s.original_url}>
                <a
                  href={s.original_url}
                  target="_blank"
                  rel="noopener nofollow noreferrer"
                  className="flex min-h-11 items-center gap-2 text-sm font-semibold text-brand hover:underline"
                >
                  <ExternalLink className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="min-w-0">
                    {sourceLabel(s.source_name, s.original_url)}
                    {s.original_title ? <span className="block truncate text-xs font-normal text-muted">{s.original_title}</span> : null}
                  </span>
                </a>
              </li>
            ))}
          </ul>
          <p className="text-xs text-subtle">{t("aiDisclaimer")}</p>
        </Card>

        <div className="space-y-4 text-base leading-relaxed text-fg">{renderNewsMarkdown(article.content_markdown)}</div>

        <div className="space-y-2 border-t border-subtle pt-4">
          <p className="text-sm font-semibold text-fg">{t("article.reactions")}</p>
          <ArticleReactions slug={article.slug} />
        </div>

        <div className="border-t border-subtle pt-4">
          <ArticleComments slug={article.slug} />
        </div>
      </article>
    </div>
  );
}
