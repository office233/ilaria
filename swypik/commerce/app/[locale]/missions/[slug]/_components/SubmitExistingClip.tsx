"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Film, Eye } from "lucide-react";
import { useRouter } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";

type CreatorVideo = {
  id: string;
  status: string;
  thumbnail_url: string | null;
  description: string | null;
  view_count: number | null;
};

/** Doar clipurile procesate pot fi înscrise din acest ecran. */
const READY_STATUSES = new Set(["ready"]);

const KNOWN_ERRORS = new Set([
  "creator_required",
  "mission_not_open",
  "video_not_eligible",
  "video_in_other_mission",
  "own_mission",
  "rate_limited",
  "invalid_body",
]);

export function SubmitExistingClip({ slug, prizeLabel }: { slug: string; prizeLabel: string }) {
  const t = useTranslations("missionsHub");
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "error" | "ready">("idle");
  const [videos, setVideos] = useState<CreatorVideo[]>([]);
  const [joined, setJoined] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const [vRes, sRes] = await Promise.all([
        fetch("/api/creator/videos", { cache: "no-store" }),
        fetch(`/api/missions/${slug}/submit`, { cache: "no-store" }),
      ]);
      if (!vRes.ok) throw new Error(String(vRes.status));
      const vData = (await vRes.json()) as { videos?: CreatorVideo[] };
      const sData = sRes.ok ? ((await sRes.json()) as { submissions?: { video_id: string; status: string }[] }) : {};
      setVideos((vData.videos ?? []).filter((v) => READY_STATUSES.has(v.status)));
      setJoined(new Set((sData.submissions ?? []).filter((s) => s.status !== "rejected").map((s) => s.video_id)));
      setState("ready");
    } catch {
      setState("error");
    }
  }, [slug]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && state !== "loading") void load();
  };

  const submit = async (videoId: string) => {
    setBusyId(videoId);
    try {
      const res = await fetch(`/api/missions/${slug}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        const code = data.error ?? "";
        toast({ title: KNOWN_ERRORS.has(code) ? t(`errors.${code}`) : t("errors.generic"), tone: "danger" });
        return;
      }
      setJoined((prev) => new Set(prev).add(videoId));
      toast({ title: t("submit.success"), description: t("submit.successHint", { amount: prizeLabel }), tone: "success" });
      router.refresh();
    } catch {
      toast({ title: t("errors.generic"), tone: "danger" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("submit.title")}
      description={t("submit.description")}
      trigger={
        <Button variant="secondary" size="lg" className="flex-1">
          {t("detail.submitExisting")}
        </Button>
      }
    >
      {state === "loading" || state === "idle" ? (
        <div className="space-y-2" aria-busy>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-control" />
          ))}
        </div>
      ) : state === "error" ? (
        <ErrorState onRetry={() => void load()} />
      ) : videos.length === 0 ? (
        <EmptyState icon={Film} title={t("submit.emptyTitle")} description={t("submit.emptyDescription")} />
      ) : (
        <ul className="space-y-2">
          {videos.map((v) => {
            const isJoined = joined.has(v.id);
            return (
              <li key={v.id} className="flex items-center gap-3 rounded-control border border-subtle bg-surface p-2">
                <div className="relative h-16 w-12 shrink-0 overflow-hidden rounded-control bg-surface-2">
                  {v.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={v.thumbnail_url} alt="" loading="lazy" className="h-full w-full object-cover" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium text-fg">{v.description || t("submit.untitled")}</p>
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                    <Eye className="h-3 w-3" aria-hidden /> {t("views", { count: v.view_count ?? 0 })}
                  </p>
                </div>
                {isJoined ? (
                  <span className="flex items-center gap-1 text-xs font-semibold text-success">
                    <CheckCircle2 className="h-4 w-4" aria-hidden /> {t("submit.joined")}
                  </span>
                ) : (
                  <Button size="sm" loading={busyId === v.id} disabled={busyId !== null} onClick={() => void submit(v.id)}>
                    {t("submit.cta")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
