/**
 * Pagina /video/[id] pentru AUTORUL unui clip care încă nu e vizibil public
 * (în procesare, în review, respins, programat, draft sau eșuat). Înainte,
 * publicarea ducea creatorul pe o pagină care îl redirecționa în gol spre /explore.
 */
import { getTranslations } from "next-intl/server";
import { Clock, Eye, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import { dbQuery } from "@/lib/db";
import { Link } from "@/lib/i18n/navigation";

type OwnerVideo = {
  id: string;
  title: string;
  thumbnail_url: string | null;
  status: string;
  visibility: string;
  moderation_status: string;
  scheduled_publish_at: string | null;
};

export async function loadOwnerVideo(id: string): Promise<OwnerVideo | null> {
  const auth = await getAuthUser();
  if (!auth.userId) return null;
  const { rows } = await dbQuery<OwnerVideo>(
    `SELECT id, title, thumbnail_url, status, visibility, moderation_status, scheduled_publish_at
       FROM videos
      WHERE id = $1 AND status <> 'deleted' AND (creator_id = $2 OR $3::boolean)
      LIMIT 1`,
    [id, auth.userId, auth.role === "admin"],
  );
  return rows[0] ?? null;
}

type StateKey = "failed" | "rejected" | "processing" | "inReview" | "scheduled" | "draft" | "notListed";

export function ownerState(v: OwnerVideo): StateKey {
  if (v.status === "failed") return "failed";
  if (v.moderation_status === "rejected") return "rejected";
  if (v.status !== "ready") return "processing";
  if (v.moderation_status === "pending_review") return "inReview";
  if (v.scheduled_publish_at) return "scheduled";
  if (v.visibility === "draft") return "draft";
  return "notListed";
}

const ICONS = { failed: TriangleAlert, rejected: ShieldAlert, processing: Clock, inReview: ShieldCheck, scheduled: Clock, draft: Eye, notListed: Eye };
const TONES = { failed: "danger", rejected: "danger", processing: "info", inReview: "warning", scheduled: "info", draft: "neutral", notListed: "neutral" } as const;

export async function OwnerVideoStatus({ video }: { video: OwnerVideo }) {
  const t = await getTranslations("videoUpload.owner");
  const state = ownerState(video);
  const Icon = ICONS[state];
  return (
    <div className="min-h-dvh bg-canvas">
      <PageHeader back="/creator/videos" title={t("title")} />
      <div className="mx-auto w-full max-w-md space-y-4 px-gutter py-6">
        <Card className="flex gap-4">
          {video.thumbnail_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={video.thumbnail_url} alt="" className="h-32 w-[72px] shrink-0 rounded-control bg-black object-cover" />
          ) : null}
          <div className="min-w-0 space-y-2">
            <p className="line-clamp-2 font-semibold text-fg">{video.title}</p>
            <Badge tone={TONES[state]}>
              <Icon className="h-3.5 w-3.5" aria-hidden /> {t(`state_${state}`)}
            </Badge>
            <p className="text-sm text-muted">{t(`hint_${state}`)}</p>
          </div>
        </Card>
        <div className="grid gap-2">
          <Button asChild block>
            <Link href={`/upload?draft=${video.id}`}>{t("edit")}</Link>
          </Button>
          <Button asChild block variant="secondary">
            <Link href="/creator/videos">{t("myVideos")}</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
