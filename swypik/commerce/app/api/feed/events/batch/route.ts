import { NextResponse } from "next/server";
import { ingestFeedEvents } from "@/lib/feed/ingest";
import { FeedEventsBatchSchema, parseBody } from "@/lib/validation/schemas";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const MAX_BATCH = 50;

/**
 * POST /api/feed/events/batch — flush de evenimente de la player.
 *
 * Body: { events: [...] } (max 50) sau un singur eveniment.
 * Identitate: sesiune de cont, shell anonim semnat (`anon_session`) sau
 * sesiune de feed semnată (`feed_sid`, emisă de /api/explore/feed). Fără
 * niciuna → 401. Gărzi anti-manipulare: vezi lib/feed/event-guards.ts.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  if (!body || typeof body !== "object") return new NextResponse(null, { status: 204 });

  const env = parseBody(FeedEventsBatchSchema, body);
  if (!env.ok) return NextResponse.json({ error: env.error }, { status: 400 });

  const obj = body as Record<string, unknown>;
  let rawEvents: unknown[];
  if (Array.isArray(obj.events)) rawEvents = obj.events;
  else if (obj.event_type || obj.type) rawEvents = [body];
  else return new NextResponse(null, { status: 204 });

  if (rawEvents.length === 0) return new NextResponse(null, { status: 204 });
  if (rawEvents.length > MAX_BATCH) {
    return NextResponse.json({ error: `max ${MAX_BATCH} events per batch` }, { status: 400 });
  }

  try {
    const out = await ingestFeedEvents(req, rawEvents);
    if (out.status === "unauthorized") {
      return NextResponse.json({ error: "feed_session_required" }, { status: 401 });
    }
    if (out.status === "rate_limited") {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }
    return NextResponse.json(
      { accepted: out.inserted, rejected: out.rejected, errors: out.errors.length ? out.errors : undefined },
      { status: 200 },
    );
  } catch (error) {
    logger.error({ err: error }, "[feed/events/batch] insert failed:");
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }
}
