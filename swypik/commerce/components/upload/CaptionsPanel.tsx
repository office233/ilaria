"use client";

import { useEffect, useState } from "react";
import { Captions, Wand2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { ListItem } from "@/components/ui/ListItem";
import { Switch } from "@/components/ui/Switch";
import { Textarea } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { formatDuration } from "@/lib/upload/media";
import { UploadApiError, videoApi } from "@/lib/upload/api";
import type { CaptionTrack } from "@/lib/video/captions";
import { useErrorText } from "./useErrorText";

/**
 * Subtitrări: comutator + (după procesare) generare automată din audio și
 * editarea textului fiecărui segment. Generarea cere un furnizor speech-to-text
 * configurat pe server; altfel creatorul primește mesajul `captions_unavailable`.
 */
export function CaptionsPanel(props: { videoId: string | null; ready: boolean; enabled: boolean; onEnabled: (v: boolean) => void }) {
  const t = useTranslations("videoUpload.captions");
  const locale = useLocale();
  const errorText = useErrorText();
  const { toast } = useToast();
  const [track, setTrack] = useState<CaptionTrack | null>(null);
  const [busy, setBusy] = useState<"generate" | "save" | null>(null);
  const { videoId, ready, enabled } = props;

  useEffect(() => {
    if (!videoId || !ready || !enabled) return;
    videoApi
      .captions(videoId)
      .then((tracks) => setTrack(tracks.find((x) => x.lang === locale) ?? tracks[0] ?? null))
      .catch(() => undefined);
  }, [videoId, ready, enabled, locale]);

  const run = async (kind: "generate" | "save") => {
    if (!videoId) return;
    setBusy(kind);
    try {
      const res =
        kind === "generate"
          ? await videoApi.generateCaptions(videoId, locale)
          : await videoApi.saveCaptions(videoId, track?.lang ?? locale, track?.segments ?? []);
      setTrack(res.track);
      if (res.held) toast({ title: t("heldForReview"), tone: "danger", duration: 8000 });
      else if (kind === "save") toast({ title: t("saved"), tone: "success" });
    } catch (err) {
      toast({ title: errorText(err instanceof UploadApiError ? err.code : null), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <ListItem
        icon={Captions}
        title={t("title")}
        subtitle={t("hint")}
        trailing={<Switch checked={enabled} onCheckedChange={props.onEnabled} aria-label={t("title")} />}
      />
      {enabled && !ready ? <p className="px-3 text-xs text-muted">{t("afterProcessing")}</p> : null}
      {enabled && ready && !track ? (
        <Button variant="secondary" block onClick={() => void run("generate")} loading={busy === "generate"}>
          <Wand2 className="h-4 w-4" aria-hidden /> {t("generate")}
        </Button>
      ) : null}
      {enabled && track ? (
        <div className="space-y-2">
          <p className="px-1 text-xs text-muted">{track.is_auto ? t("autoHint") : t("editedHint")}</p>
          <ol className="max-h-80 space-y-2 overflow-y-auto">
            {track.segments.map((seg, i) => (
              <li key={`${seg.start}-${i}`} className="space-y-1">
                <span className="text-xs tabular-nums text-muted">
                  {formatDuration(seg.start * 1000)} – {formatDuration(seg.end * 1000)}
                </span>
                <Textarea
                  rows={2}
                  className="min-h-0"
                  aria-label={t("segmentLabel", { n: i + 1 })}
                  value={seg.text}
                  onChange={(e) =>
                    setTrack((cur) =>
                      cur
                        ? { ...cur, segments: cur.segments.map((s, j) => (j === i ? { ...s, text: e.target.value } : s)) }
                        : cur,
                    )
                  }
                />
              </li>
            ))}
          </ol>
          <Button block onClick={() => void run("save")} loading={busy === "save"}>
            {t("save")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
