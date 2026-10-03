"use client";

import { useEffect, useRef, useState } from "react";
import { useRealtimeKitClient } from "@cloudflare/realtimekit-react";
import { RtkMeeting } from "@cloudflare/realtimekit-react-ui";
import { Loader2, Maximize2, Minimize2, PhoneOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/lib/ui/cn";

interface ActiveCallOverlayProps {
  authToken: string;
  callType?: "audio" | "video";
  onDisconnect: () => void;
}

/**
 * Apelul activ pe Cloudflare RealtimeKit: token-ul participantului (emis de
 * /api/messenger/calls/token) → SDK → UI Kit-ul oficial (`RtkMeeting`).
 * Încărcat doar prin next/dynamic, când chiar pornește un apel.
 */
export default function ActiveCallOverlay({ authToken, callType = "video", onDisconnect }: ActiveCallOverlayProps) {
  const t = useTranslations("messenger.activeCall");
  const [isPip, setIsPip] = useState(false);
  const [failed, setFailed] = useState(false);
  const [meeting, initMeeting] = useRealtimeKitClient();
  const onDisconnectRef = useRef(onDisconnect);
  onDisconnectRef.current = onDisconnect;

  useEffect(() => {
    let cancelled = false;
    initMeeting({ authToken, defaults: { audio: true, video: callType === "video" } })
      .then((m) => {
        if (!m && !cancelled) setFailed(true);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [authToken, callType, initMeeting]);

  useEffect(() => {
    if (!meeting) return;
    const onLeft = () => onDisconnectRef.current();
    meeting.self.on("roomLeft", onLeft);
    return () => {
      meeting.self.off("roomLeft", onLeft);
      // Închiderea overlay-ului (buton, navigare) iese și din cameră.
      void meeting.leave().catch(() => undefined);
    };
  }, [meeting]);

  return (
    <div
      className={cn(
        "fixed z-overlay flex flex-col overflow-hidden bg-canvas text-fg",
        isPip
          ? "bottom-[calc(var(--bottom-inset)+1rem)] right-4 h-72 w-[min(24rem,calc(100vw-2rem))] rounded-card border border-subtle shadow-elev-3"
          : "inset-0 h-dvh pt-safe-t pb-safe-b",
      )}
      role="dialog"
      aria-modal={!isPip}
    >
      <div className="absolute right-3 top-[calc(env(safe-area-inset-top,0px)+0.75rem)] z-20 flex gap-2">
        <IconButton variant="overlay" label={isPip ? t("expand") : t("minimize")} onClick={() => setIsPip((p) => !p)}>
          {isPip ? <Maximize2 aria-hidden /> : <Minimize2 aria-hidden />}
        </IconButton>
        <IconButton variant="overlay" className="bg-danger text-white hover:bg-danger" label={t("end")} onClick={onDisconnect}>
          <PhoneOff aria-hidden />
        </IconButton>
      </div>

      <div className="relative h-full w-full flex-1">
        {failed ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-gutter text-center" role="alert">
            <p className="text-sm text-muted">{t("failed")}</p>
            <Button variant="secondary" onClick={onDisconnect}>
              {t("close")}
            </Button>
          </div>
        ) : meeting ? (
          <RtkMeeting meeting={meeting} mode="fill" showSetupScreen={false} className="h-full w-full" />
        ) : (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted" role="status">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
            {t("connecting")}
          </div>
        )}
      </div>
    </div>
  );
}
