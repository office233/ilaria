"use client";

import { useEffect, useRef } from "react";
import { Loader2, Mic, MicOff, Video, VideoOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/ui/cn";

type Props = {
  media: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
};

/**
 * Previzualizarea camerei gazdei (oglindită) + comutatoare microfon/cameră.
 * Publicarea în SFU-ul Cloudflare o face useHostPublisher; aici doar afișăm.
 */
export default function HostRoom({ media, micOn, camOn, onToggleMic, onToggleCam }: Props) {
  const t = useTranslations("live.studio");
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = media;
  }, [media]);

  return (
    <div className="relative h-full w-full bg-canvas">
      {media ? (
        <video ref={videoRef} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center gap-2 text-sm text-muted" role="status">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          {t("startingCamera")}
        </div>
      )}
      <div className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col gap-3">
        <IconButton variant="overlay" label={t("toggleMic")} aria-pressed={micOn} className={cn(!micOn && "bg-danger")} onClick={onToggleMic}>
          {micOn ? <Mic aria-hidden /> : <MicOff aria-hidden />}
        </IconButton>
        <IconButton variant="overlay" label={t("toggleCamera")} aria-pressed={camOn} className={cn(!camOn && "bg-danger")} onClick={onToggleCam}>
          {camOn ? <Video aria-hidden /> : <VideoOff aria-hidden />}
        </IconButton>
      </div>
    </div>
  );
}
