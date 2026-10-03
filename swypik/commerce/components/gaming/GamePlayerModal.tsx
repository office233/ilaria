"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { RotateCcw, X } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { useToast } from "@/components/ui/Toast";
import ImmersiveSurface from "@/components/theme/ImmersiveSurface";
import { logger } from "@/lib/logger";
import { GAME_STRING_KEYS, isGameOverMessage, isGameStartMessage, isSafeGameUrl, type GameStrings } from "@/lib/gaming/postmessage";

type Game = { id: string; title: string; embed_url: string };

type Props = {
  game: Game | null;
  /** Signed-in account: rounds are scored and earn XP. Guests just play. */
  canEarn: boolean;
  onClose: () => void;
  /** Called after a score submission changed the user's XP. */
  onScoreChanged?: () => void;
};

/** A START within this window of an unused token reuses it (2048 posts START on load). */
const START_DEDUPE_MS = 1500;

/**
 * Full-screen game player. Every (re)start inside the game posts
 * SWYPIK_GAME_START, which opens a fresh signed scoring session — so replays
 * after "game over" score too (audit G3), not just the first round.
 */
export default function GamePlayerModal({ game, canEarn, onClose, onScoreChanged }: Props) {
  const t = useTranslations("gaming");
  const { toast } = useToast();
  const [iframeKey, setIframeKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const session = useRef<{ token: string | null; issuedAt: number; pending: boolean }>({ token: null, issuedAt: 0, pending: false });

  const strings = useMemo(
    () => Object.fromEntries(GAME_STRING_KEYS.map((k) => [k, t(`game.${k}`)])) as GameStrings,
    [t],
  );

  const startSession = useCallback(async (gameId: string) => {
    const s = session.current;
    if (!canEarn || s.pending) return;
    if (s.token && Date.now() - s.issuedAt < START_DEDUPE_MS) return;
    s.pending = true;
    try {
      const res = await fetch("/api/gaming/session/start", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const d = await res.json();
      session.current = { token: d.ok ? d.sessionToken : null, issuedAt: Date.now(), pending: false };
    } catch (err) {
      logger.warn({ err }, "[gaming.modal] session start failed");
      session.current = { token: null, issuedAt: 0, pending: false };
    }
  }, [canEarn]);

  const submitScore = useCallback(async (gameId: string, score: number) => {
    const token = session.current.token;
    session.current.token = null; // single-use server-side regardless of outcome
    if (!token) return;
    try {
      const res = await fetch("/api/gaming/score", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId, score: Math.max(0, Math.floor(score)), sessionToken: token }),
      });
      const d = await res.json();
      if (d.ok) {
        toast({ title: t("modal.scoreSaved", { score: d.score, xp: d.earnedXp }), tone: "success" });
        if (d.earnedXp > 0) onScoreChanged?.();
      }
    } catch (err) {
      logger.warn({ err }, "[gaming.modal] score submit failed");
    }
  }, [onScoreChanged, t, toast]);

  // Fresh scoring state per opened game (not per re-render of the callbacks below).
  useEffect(() => {
    session.current = { token: null, issuedAt: 0, pending: false };
  }, [game?.id]);

  useEffect(() => {
    if (!game) return;
    const onMessage = (e: MessageEvent) => {
      // The iframe is same-origin (/games/…); anything else is ignored.
      if (e.origin !== window.location.origin || e.source !== iframeRef.current?.contentWindow) return;
      if (isGameStartMessage(e.data) && e.data.gameId === game.id) void startSession(game.id);
      else if (isGameOverMessage(e.data) && e.data.gameId === game.id) void submitScore(game.id, e.data.score);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKey);
    };
  }, [game, onClose, startSession, submitScore]);

  if (!game) return null;
  if (!isSafeGameUrl(game.embed_url)) {
    logger.error({ gameId: game.id }, "[gaming.modal] refusing to load unsafe game url");
    return null;
  }

  const sendStrings = () => {
    iframeRef.current?.contentWindow?.postMessage({ type: "SWYPIK_GAME_STRINGS", strings }, window.location.origin);
  };

  return (
    <div className="fixed inset-0 z-overlay" role="dialog" aria-modal="true" aria-label={game.title}>
      <ImmersiveSurface fullscreen className="flex h-dvh flex-col">
        <header className="flex items-center gap-2 border-b border-subtle px-gutter pb-2 pt-safe-t">
          <h2 className="min-w-0 flex-1 truncate py-3 text-base font-semibold text-fg">{game.title}</h2>
          <IconButton label={t("modal.restart")} onClick={() => setIframeKey((k) => k + 1)}>
            <RotateCcw className="h-5 w-5" aria-hidden />
          </IconButton>
          <IconButton label={t("modal.close")} onClick={onClose}>
            <X className="h-5 w-5" aria-hidden />
          </IconButton>
        </header>
        {!canEarn && <p className="bg-warning-soft px-gutter py-2 text-center text-xs text-warning">{t("modal.guest")}</p>}
        <div className="relative flex-1 pb-safe-b">
          <iframe
            key={iframeKey}
            ref={iframeRef}
            src={game.embed_url}
            onLoad={sendStrings}
            sandbox="allow-scripts allow-same-origin"
            allow="autoplay; fullscreen"
            className="h-full w-full border-0"
            title={game.title}
          />
        </div>
      </ImmersiveSurface>
    </div>
  );
}
