/** Răspunsuri comune ale rutelor media Live (publish / watch / heartbeat / ice). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { RealtimeUnavailableError } from "@/lib/realtime/config";
import { RealtimeApiError } from "@/lib/realtime/http";
import { LiveMediaError } from "./media";

export function liveUnavailable(): NextResponse {
  return NextResponse.json({ error: "live_unavailable" }, { status: 503 });
}

/** SDP limitat ca dimensiune (un SDP real are câțiva KB). */
export const SdpSchema = (type: "offer" | "answer") =>
  z.object({ type: z.literal(type), sdp: z.string().min(10).max(64_000) });

/** Id de sesiune SFU (hex/uuid-like, fără caractere de cale). */
export const SfuSessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

export function liveMediaErrorResponse(err: unknown, context: Record<string, unknown>): NextResponse {
  if (err instanceof LiveMediaError) return NextResponse.json({ error: err.code }, { status: err.status });
  if (err instanceof RealtimeUnavailableError) return liveUnavailable();
  if (err instanceof RealtimeApiError) {
    logger.error({ ...context, code: err.code, status: err.status, err: err.message }, "[live] SFU call failed");
    return NextResponse.json({ error: "sfu_failed" }, { status: 502 });
  }
  logger.error({ ...context, err }, "[live] media route failed");
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
