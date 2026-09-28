import {
  fallbackAccepted,
  isBatchFallbackStatus,
  normalizeBatchPayload,
  postJSONToGo,
  postLegacyEvents,
  toGoBatchPayload,
  validationError,
} from "../compat";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";

import { logger } from "@/lib/logger";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const rl = await rateLimit("socialEvents", getClientIP(req));
    if (!rl.success) {
      return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json" } });
    }
    const body = await req.json().catch(() => null);
    const batch = normalizeBatchPayload(body);

    if (!batch || batch.events.length === 0) {
      return validationError("Events array is empty or invalid");
    }

    if (batch.events.length > 100) {
      return validationError("Max 100 events per batch");
    }

    const upstreamBatch = await postJSONToGo(req, "/v1/events/batch", toGoBatchPayload(batch));
    if (upstreamBatch && !isBatchFallbackStatus(upstreamBatch.status)) {
      return upstreamBatch;
    }
    await upstreamBatch?.arrayBuffer().catch(() => null);

    const legacy = await postLegacyEvents(req, batch);
    if (legacy && legacy.accepted > 0) {
      return fallbackAccepted(legacy.accepted, "go-legacy");
    }

    return fallbackAccepted(batch.events.length);
  } catch (error) {
    logger.error({ err: error }, "[Social Events Batch Fallback]");
    return fallbackAccepted(0);
  }
}
