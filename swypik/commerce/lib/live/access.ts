/**
 * Regulile Live, pure și testabile separat:
 *  - cine poate publica (doar gazda/admin, stream ne-încheiat) și cine poate
 *    trage media (oricine, doar cât streamul e confirmat live și are sesiune SFU);
 *  - mașina de stări a heartbeat-ului:
 *      scheduled ──(heartbeat gazdă + track local activ în SFU)──▶ live
 *      live ──(gazda încheie / heartbeat expirat)──▶ ended   (ireversibil)
 */
import type { LiveStatus } from "./queries";

export type LiveRole = "host" | "viewer";
export type Viewer = { userId: string; role: string | null } | null;

export type AccessDecision =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 409; error: "unauthorized" | "forbidden" | "stream_not_live" | "stream_ended" };

type StreamGate = { status: LiveStatus; creator_id: string; sfu_session_id?: string | null };

export function decideLiveAccess(role: LiveRole, stream: StreamGate, viewer: Viewer): AccessDecision {
  if (role === "host") {
    if (!viewer) return { ok: false, status: 401, error: "unauthorized" };
    if (stream.creator_id !== viewer.userId && viewer.role !== "admin") return { ok: false, status: 403, error: "forbidden" };
    if (stream.status === "ended" || stream.status === "failed") return { ok: false, status: 409, error: "stream_ended" };
    return { ok: true };
  }
  if (stream.status !== "live" || !stream.sfu_session_id) return { ok: false, status: 409, error: "stream_not_live" };
  return { ok: true };
}

export type LiveTransition = "go_live" | "stay_live" | "end" | "wait" | "none";

/**
 * @param hostAlive    heartbeat-ul gazdei e în TTL
 * @param mediaActive  SFU-ul raportează un track local activ (null = neverificat)
 */
export function decideTransition(input: { status: LiveStatus; hostAlive: boolean; mediaActive: boolean | null }): LiveTransition {
  const { status, hostAlive, mediaActive } = input;
  if (status === "ended" || status === "failed") return "none";
  if (status === "live") return hostAlive ? "stay_live" : "end";
  return hostAlive && mediaActive === true ? "go_live" : "wait";
}
