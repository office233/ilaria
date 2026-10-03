"use client";
import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { useHlsVideo } from "@/lib/video/useHlsVideo";
import { Button } from "@/components/ui/Button";

type Props = {
  src: string;
  poster: string | null;
  muted: boolean;
  resumeMs: number;
  onEnded: () => void;
  onTime: (ms: number) => void;
  onError: () => void;
  /** Filmele (16:9, lungi) se afișează întregi (letterbox), serialele verticale umplu ecranul. */
  fit: "cover" | "contain";
};

/**
 * Un stream care rămâne blocat (`waiting` fără `playing`) atâta timp e tratat ca
 * eroare: hls.js își consumă intern reîncercările și nu mai emite nimic, iar
 * token-ul semnat poate fi expirat — PlayerClient reîncarcă sursa (limitat).
 */
const STALL_TIMEOUT_MS = 20_000;

/**
 * Video-ul episodului. Dacă browserul refuză autoplay-ul cu sunet (mobil),
 * arătăm un buton „Atinge pentru redare" în loc să eșueze în tăcere.
 */
export default function EpisodeVideo({ src, poster, muted, resumeMs, onEnded, onTime, onError, fit }: Props) {
  const t = useTranslations("movies");
  const ref = useHlsVideo(src);
  const [needsTap, setNeedsTap] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    setNeedsTap(false);
    const seek = () => {
      if (resumeMs > 0 && v.currentTime < resumeMs / 1000) v.currentTime = resumeMs / 1000;
    };
    v.addEventListener("loadedmetadata", seek, { once: true });
    v.play().catch(() => setNeedsTap(true));
    return () => v.removeEventListener("loadedmetadata", seek);
  }, [ref, src, resumeMs]);

  // Watchdog de blocaj → onError (reîncărcare cu un URL/token proaspăt).
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const arm = () => {
      clear();
      if (!v.paused) timer = setTimeout(onError, STALL_TIMEOUT_MS);
    };
    v.addEventListener("waiting", arm);
    v.addEventListener("stalled", arm);
    for (const ev of ["playing", "pause", "seeked", "ended"]) v.addEventListener(ev, clear);
    return () => {
      clear();
      v.removeEventListener("waiting", arm);
      v.removeEventListener("stalled", arm);
      for (const ev of ["playing", "pause", "seeked", "ended"]) v.removeEventListener(ev, clear);
    };
  }, [ref, src, onError]);

  const tapToPlay = () => {
    const v = ref.current;
    if (!v) return;
    v.play().then(() => setNeedsTap(false)).catch(() => setNeedsTap(true));
  };

  return (
    <>
      <video
        ref={ref}
        className={fit === "contain" ? "h-full w-full bg-canvas object-contain" : "h-full w-full object-cover"}
        // Controale native: pauză, derulare, ecran complet (inclusiv pentru filmele lungi).
        controls
        controlsList="nodownload"
        playsInline
        muted={muted}
        poster={poster ?? undefined}
        onEnded={onEnded}
        onError={onError}
        onTimeUpdate={(e) => onTime(e.currentTarget.currentTime * 1000)}
      />
      {needsTap && (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <Button size="lg" onClick={tapToPlay}>
            <Play className="h-4 w-4" fill="currentColor" aria-hidden /> {t("tapToPlay")}
          </Button>
        </div>
      )}
    </>
  );
}
