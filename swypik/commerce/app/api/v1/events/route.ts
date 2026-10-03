import {
  fallbackAccepted,
  bindBatchIdentity,
  isBatchFallbackStatus,
  normalizeBatchPayload,
  postJSONToGo,
  postLegacyEvents,
  toGoBatchPayload,
  validationError,
} from "./compat";
import { rateLimit, getClientIP } from "@/lib/security/rate-limit";
import { ABUSE_LIMITS } from "@/lib/security/abuse-limits";
import { resolvePlatformEventIdentity } from "@/lib/events/platform-identity";

import { logger } from "@/lib/logger";
export async function POST(req: Request) {
  try {
    const rl = await rateLimit("socialEvents", getClientIP(req));
    if (!rl.success) {
      return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json" } });
    }
    const body = await req.json().catch(() => null);
    const normalized = normalizeBatchPayload(body);

    if (!normalized || normalized.events.length !== 1) {
      return validationError("Expected a single valid event");
    }

    const identity = await resolvePlatformEventIdentity();
    const identityLimit = await rateLimit(
      "platformEventsIdentity",
      identity.rateLimitKey,
      ABUSE_LIMITS.platformEventsPerIdentity,
    );
    if (!identityLimit.success) {
      return new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    const batch = bindBatchIdentity(normalized, identity);

    const upstreamBatch = await postJSONToGo(req, "/v1/events/batch", toGoBatchPayload(batch));
    if (upstreamBatch && !isBatchFallbackStatus(upstreamBatch.status)) {
      return upstreamBatch;
    }
    await upstreamBatch?.arrayBuffer().catch(() => null);

    const legacy = await postLegacyEvents(req, batch);
    if (legacy && legacy.accepted === 1) return fallbackAccepted(1, "go-legacy");

    return fallbackAccepted(1);
  } catch (error) {
    logger.error({ err: error }, "[Social Events Fallback]");
    return fallbackAccepted(0);
  }
}
