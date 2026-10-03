"use client";

import { useEffect, useRef, useState } from "react";
import { VideoOff } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * Redarea track-urilor gazdei (doar recepție). Browserele blochează sunetul
 * automat: încercăm cu sunet, iar la refuz pornim fără sunet și arătăm butonul.
 */
export default function LiveVideo({ media }: { media: MediaStream | null }) {
  const t = useTranslations("live.viewer");
  const videoRef = useRef<HTMLVideoElement>(null);
  const [needsTap, setNeedsTap] = useState(false);
  const hasVideo = Boolean(media?.getVideoTracks().length);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !media) return;
    el.srcObject = media;
    el.muted = false;
    el.play().catch(() => {
      el.muted = true;
      setNeedsTap(true);
      void el.play().catch(() => undefined);
    });
  }, [media]);

  const unmute = () => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = false;
    void el.play().then(() => setNeedsTap(false)).catch(() => undefined);
  };

  return (
    <div className="relative h-full w-full bg-canvas">
      <video ref={videoRef} autoPlay playsInline className="h-full w-full object-cover" />
      {!hasVideo ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted">
          <VideoOff className="h-8 w-8" aria-hidden />
          {t("waitingForHost")}
        </div>
      ) : null}
      {needsTap ? (
        <button
          type="button"
          onClick={unmute}
          className="absolute left-1/2 top-1/2 z-10 min-h-11 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/60 px-5 text-sm font-semibold text-white backdrop-blur"
        >
          {t("tapForSound")}
        </button>
      ) : null}
    </div>
  );
}
