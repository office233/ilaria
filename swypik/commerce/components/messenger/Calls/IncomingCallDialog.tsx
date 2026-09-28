"use client";

import { useEffect, useRef } from "react";
import { Phone, PhoneOff, Video } from "lucide-react";
import { useTranslations } from "next-intl";

interface IncomingCallDialogProps {
  callerName: string;
  callerAvatar?: string;
  callType: "audio" | "video";
  onAccept: () => void;
  onReject: () => void;
}

export default function IncomingCallDialog({
  callerName,
  callerAvatar,
  callType,
  onAccept,
  onReject,
}: IncomingCallDialogProps) {
  const t = useTranslations("messenger.incomingCall");
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Sintetizator ton de apel stil WhatsApp prin Web Audio API
  useEffect(() => {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof window.AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        audioCtxRef.current = ctx;

        let isRunning = true;
        const playRing = () => {
          if (!isRunning || ctx.state === "closed") return;
          const osc1 = ctx.createOscillator();
          const osc2 = ctx.createOscillator();
          const gain = ctx.createGain();

          osc1.frequency.value = 440; // A4
          osc2.frequency.value = 480; // B4

          gain.gain.setValueAtTime(0.1, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.2);

          osc1.connect(gain);
          osc2.connect(gain);
          gain.connect(ctx.destination);

          osc1.start();
          osc2.start();
          osc1.stop(ctx.currentTime + 1.2);
          osc2.stop(ctx.currentTime + 1.2);

          if (isRunning) {
            setTimeout(playRing, 3000);
          }
        };

        playRing();

        return () => {
          isRunning = false;
          ctx.close().catch(() => null);
        };
      }
    } catch {
      // Web Audio unavailable (e.g. autoplay policy) — dialog still works, just silent.
    }
  }, []);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={callType === "video" ? t("incomingVideo") : t("incomingAudio")}
      className="fixed inset-0 z-overlay flex items-center justify-center bg-overlay p-4 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-sm flex-col items-center rounded-card border border-subtle bg-surface p-6 text-center shadow-2xl">
        {/* Avatar pulsând */}
        <div className="relative mb-6">
          <div className="absolute inset-0 animate-ping rounded-full bg-success-soft" />
          <div className="relative flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border-2 border-success bg-surface-2 shadow-xl">
            {callerAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={callerAvatar} alt={callerName} className="h-full w-full object-cover" />
            ) : (
              <span className="text-3xl font-bold text-success">{callerName.charAt(0).toUpperCase()}</span>
            )}
          </div>
        </div>

        <h3 className="mb-1 text-xl font-bold text-fg">{callerName}</h3>
        <p className="mb-8 flex items-center gap-1.5 text-sm text-muted">
          {callType === "video" ? <Video size={16} className="text-brand" aria-hidden /> : <Phone size={16} className="text-brand" aria-hidden />}
          {callType === "video" ? t("incomingVideo") : t("incomingAudio")}
        </p>

        <div className="flex w-full items-center justify-center gap-12">
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={onReject}
              aria-label={t("decline")}
              className="flex h-16 w-16 items-center justify-center rounded-full bg-danger text-fg-inverse shadow-lg transition hover:bg-danger/90 active:scale-95"
            >
              <PhoneOff size={26} aria-hidden />
            </button>
            <span className="text-xs text-muted">{t("decline")}</span>
          </div>

          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={onAccept}
              aria-label={t("accept")}
              className="flex h-16 w-16 animate-pulse items-center justify-center rounded-full bg-success text-fg-inverse shadow-xl transition hover:bg-success/90 active:scale-95"
            >
              <Phone size={26} aria-hidden />
            </button>
            <span className="text-xs font-bold text-success">{t("accept")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
