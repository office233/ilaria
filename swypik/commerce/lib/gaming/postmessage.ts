/**
 * Shared validation for the arcade iframe <-> parent postMessage bridge.
 * Extracted from components/gaming/GamePlayerModal.tsx so it's unit
 * testable without mounting React.
 */

export type GameOverMessage = { type: "SWYPIK_GAME_OVER"; gameId: string; score: number; durationMs?: number };

/**
 * Only same-origin /games/<slug>/... paths may ever be loaded in the
 * sandboxed iframe (`allow-same-origin` + an attacker-controlled src would
 * let a malicious page read/write this origin's cookies and DOM).
 */
export function isSafeGameUrl(url: string): boolean {
  if (typeof url !== "string" || !url.startsWith("/games/")) return false;
  if (url.includes("//")) return false; // blocks protocol-relative / absolute tricks
  if (url.includes("..")) return false;
  return true;
}

export function isGameOverMessage(data: unknown): data is GameOverMessage {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (d.type !== "SWYPIK_GAME_OVER") return false;
  if (typeof d.gameId !== "string" || d.gameId.length === 0) return false;
  if (typeof d.score !== "number" || !Number.isFinite(d.score)) return false;
  return true;
}

export type GameStartMessage = { type: "SWYPIK_GAME_START"; gameId: string };

/** Sent by a game on every (re)start so the parent opens a fresh scoring session (audit G3). */
export function isGameStartMessage(data: unknown): data is GameStartMessage {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return d.type === "SWYPIK_GAME_START" && typeof d.gameId === "string" && d.gameId.length > 0;
}

/** UI strings the parent sends into the game iframe (the games carry no hardcoded copy). */
export const GAME_STRING_KEYS = ["score", "best", "gameOver", "playAgain", "restart", "tapToStart", "tapToRestart", "controls"] as const;
export type GameStrings = Record<(typeof GAME_STRING_KEYS)[number], string>;
