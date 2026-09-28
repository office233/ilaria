"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Film, History } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ListItem } from "@/components/ui/ListItem";
import { uploadApi, type UploadStatus } from "@/lib/upload/api";
import { activeUploads } from "@/lib/upload/draft-store";
import { VIDEO_LIMITS, maxDurationSec, maxUploadMb } from "@/lib/video/limits";

export type ResumeRequest = { sessionId: string; videoId: string; file: Blob | null; name: string };

/** Pasul 1: filmează, alege din galerie sau reia un upload neterminat. */
export function PickStep(props: {
  onRecord: () => void;
  onPicked: (file: File) => void;
  onResume: (req: ResumeRequest) => void;
  error: string | null;
}) {
  const t = useTranslations("videoUpload.pick");
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<UploadStatus[]>([]);

  useEffect(() => {
    let alive = true;
    uploadApi
      .openSessions()
      .then((s) => alive && setOpen(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const resume = async (s: UploadStatus) => {
    const local = activeUploads.list().find((u) => u.sessionId === s.sessionId);
    const file = await activeUploads.file(s.sessionId);
    props.onResume({ sessionId: s.sessionId, videoId: s.videoId, file, name: local?.name ?? s.title ?? "" });
  };

  return (
    <div className="mx-auto w-full max-w-md space-y-4 px-gutter py-4">
      <Card variant="elevated" padding="lg" className="space-y-4 text-center">
        <p className="text-lg font-semibold text-fg">{t("title")}</p>
        <p className="text-sm text-muted">{t("subtitle")}</p>
        <div className="grid gap-3">
          <Button size="lg" block onClick={props.onRecord}>
            <Camera className="h-5 w-5" aria-hidden /> {t("record")}
          </Button>
          <Button size="lg" variant="secondary" block onClick={() => inputRef.current?.click()}>
            <Film className="h-5 w-5" aria-hidden /> {t("gallery")}
          </Button>
        </div>
        <p className="text-xs text-muted">
          {t("limits", { mb: maxUploadMb(), sec: maxDurationSec() })}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={[...VIDEO_LIMITS.acceptedMimeTypes, ...VIDEO_LIMITS.acceptedExtensions].join(",")}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) props.onPicked(f);
          }}
        />
      </Card>

      {props.error ? (
        <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">
          {props.error}
        </p>
      ) : null}

      {open.length > 0 ? (
        <section aria-labelledby="resume-heading" className="space-y-2">
          <h2 id="resume-heading" className="text-sm font-semibold text-muted">
            {t("resumeTitle")}
          </h2>
          <Card padding="none" className="divide-y divide-subtle overflow-hidden">
            {open.map((s) => (
              <ListItem
                key={s.sessionId}
                icon={History}
                title={s.title || t("untitled")}
                subtitle={t("resumeHint", { mb: Math.max(1, Math.round(s.byteSize / (1024 * 1024))) })}
                onClick={() => void resume(s)}
              />
            ))}
          </Card>
        </section>
      ) : null}
    </div>
  );
}
