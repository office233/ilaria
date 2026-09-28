import { getLocale, getTranslations } from "next-intl/server";
import { CheckCircle2, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import type { QueueVideo } from "@/lib/admin/moderation/queue";
import { VideoDecisionActions } from "./VideoDecisionActions";

/** Coada de clipuri (în așteptare / semnalate) — carduri, la fel pe mobil și desktop. */
export async function VideoQueue({ videos, flagged }: { videos: QueueVideo[]; flagged: boolean }) {
  const t = await getTranslations("adminConsole.moderation");
  const locale = await getLocale();
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  if (videos.length === 0) {
    return <EmptyState icon={CheckCircle2} title={t(flagged ? "emptyFlagged" : "emptyPending")} />;
  }

  return (
    <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {videos.map((v) => {
        const title = v.title || t("untitled");
        return (
          <li key={v.id} className="flex gap-3 rounded-card border border-subtle bg-surface p-3">
            {v.thumbnail_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={v.thumbnail_url} alt="" className="h-36 w-24 shrink-0 rounded-control bg-surface-2 object-cover" />
            ) : (
              <div className="h-36 w-24 shrink-0 rounded-control bg-surface-2" aria-hidden />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="min-w-0">
                <p className="line-clamp-2 font-semibold text-fg">{title}</p>
                <p className="text-sm text-muted">
                  {v.creator_username ? `@${v.creator_username}` : "—"} · {fmt.format(new Date(v.created_at))}
                </p>
                {v.description ? <p className="mt-1 line-clamp-2 text-sm text-muted">{v.description}</p> : null}
              </div>
              <div className="flex flex-wrap gap-1">
                <Badge tone={v.moderation_status === "pending_review" ? "warning" : "neutral"} size="sm">
                  {t(`status.${v.moderation_status}`)}
                </Badge>
                {(v.flag_reasons ?? []).map((r) => (
                  <Badge key={r} tone="danger" size="sm">{r}</Badge>
                ))}
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-2">
                <VideoDecisionActions videoId={v.id} title={title} />
                {v.playback_url ? (
                  <a
                    href={v.playback_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-9 items-center gap-1 text-sm font-medium text-brand"
                  >
                    {t("preview")} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </a>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
