import { NextResponse } from "next/server";
import { ingestFeedEvents } from "@/lib/feed/ingest";
import { normalizeFeedEvent } from "@/lib/feed/events";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/feed/event — un singur eveniment (fire-and-forget).
 *
 * Aceleași reguli ca /api/feed/events/batch: identitate verificată (cont,
 * `anon_session` sau `feed_sid` semnat), altfel 401; rate limit per IP și per
 * identitate; gărzi anti-manipulare (lib/feed/event-guards.ts).
 * 204 la acceptare, 4xx la validare.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // Validare timpurie: erorile de format rămân 400 (nu 204).
  const check = normalizeFeedEvent(body, "validation");
  if ("error" in check) return NextResponse.json({ error: check.error }, { status: 400 });

  try {
    const out = await ingestFeedEvents(req, [body]);
    if (out.status === "unauthorized") {
      return NextResponse.json({ error: "feed_session_required" }, { status: 401 });
    }
    if (out.status === "rate_limited") {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
  } catch (error) {
    logger.error({ err: error }, "[feed/event] insert failed:");
    // Tracking: clientul nu reîncearcă la erori de server.
  }
  return new NextResponse(null, { status: 204 });
}
