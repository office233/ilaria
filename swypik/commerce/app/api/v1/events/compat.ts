import { NextResponse } from "next/server";
import { getSocialApiBaseUrl } from "@/lib/social/proxy";

export const dynamic = "force-dynamic";

type RawEvent = Record<string, unknown>;

export type FeedEvent = {
  id?: string;
  type: string;
  actor_id?: string;
  subject_type: string;
  subject_id: string;
  occurred_at?: string;
  video_id?: string;
  product_id?: string;
  creator_id?: string;
  watch_ms?: number;
  position_ms?: number;
  metadata?: Record<string, unknown>;
};

export type FeedEventBatch = {
  session_id: string;
  events: FeedEvent[];
};

const PLATFORM_EVENT_TYPES = new Set([
  "video_impression",
  "video_start",
  "video_progress",
  "video_complete",
  "video_rewatch",
  "video_like",
  "video_unlike",
  "video_save",
  "video_share",
  "comment_create",
  "profile_open",
  "product_click",
  "add_to_cart",
  "checkout_start",
  "purchase_complete",
  "report_video",
  "not_interested",
  "follow_creator",
]);

const LEGACY_EVENT_TYPE_MAP: Record<string, string> = {
  view: "video_impression",
  impression: "video_impression",
  watch: "video_progress",
  progress: "video_progress",
  complete: "video_complete",
  swipe: "video_start",
  like: "video_like",
  unlike: "video_unlike",
  save: "video_save",
  share: "video_share",
  comment_open: "comment_create",
  product_click: "product_click",
  add_to_cart: "add_to_cart",
};

const PRODUCT_SUBJECT_EVENT_TYPES = new Set([
  "product_click",
  "add_to_cart",
  "checkout_start",
  "purchase_complete",
]);

const CREATOR_SUBJECT_EVENT_TYPES = new Set([
  "profile_open",
  "follow_creator",
]);

export function isBatchFallbackStatus(status: number) {
  return status === 404 || status === 405 || status === 501;
}

export function fallbackAccepted(count: number, source = "next-fallback") {
  return NextResponse.json(
    {
      ok: true,
      accepted: true,
      persisted: false,
      count,
      source,
    },
    { status: 202 }
  );
}

export function validationError(message: string) {
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}

export function normalizeBatchPayload(body: unknown): FeedEventBatch | null {
  const source = isRecord(body) ? body : {};
  const sourceSessionId = asString(
    source.session_id ||
      source.sessionId ||
      source.actor_id ||
      source.actorId ||
      source.user_id ||
      source.userId
  );
  const rawEvents = Array.isArray(source.events)
    ? source.events
    : Array.isArray(body)
      ? body
      : isRecord(body)
        ? [body]
        : [];

  const normalizedEvents = rawEvents
    .map((event) => (isRecord(event) ? normalizeEvent(event, sourceSessionId) : null))
    .filter((event): event is FeedEvent => Boolean(event));

  const sessionId = sourceSessionId || normalizedEvents.find((event) => event.actor_id)?.actor_id || "web-anonymous";
  const events = normalizedEvents.map((event) => ({
    ...event,
    actor_id: event.actor_id || sessionId,
  }));

  return {
    session_id: sessionId,
    events,
  };
}

export function toGoBatchPayload(batch: FeedEventBatch) {
  return {
    events: batch.events.map(toGoEvent),
  };
}

export async function postJSONToGo(req: Request, path: string, payload: unknown) {
  const baseUrl = getSocialApiBaseUrl();
  if (!baseUrl) return null;

  const upstreamUrl = new URL(path.replace(/^\//, ""), baseUrl);
  const authorization = req.headers.get("authorization");

  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  if (authorization) headers.set("Authorization", authorization);

  const upstream = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    cache: "no-store",
    redirect: "manual",
  });

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.set("x-Swypik-upstream", "go-social-api");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export async function postLegacyEvents(req: Request, batch: FeedEventBatch) {
  const baseUrl = getSocialApiBaseUrl();
  if (!baseUrl) return null;

  let accepted = 0;
  let lastStatus = 202;

  for (const event of batch.events) {
    const upstream = await postJSONToGo(req, "/v1/events", toLegacyEvent(event, batch.session_id));
    if (!upstream) return null;
    lastStatus = upstream.status;
    if (upstream.ok) accepted += 1;
    await upstream.arrayBuffer().catch(() => null);
  }

  return { accepted, lastStatus };
}

function normalizeEvent(raw: RawEvent, sourceSessionId = ""): FeedEvent | null {
  const rawType = asString(raw.type || raw.event_type || raw.eventType);
  const type = normalizeEventType(rawType, raw);
  if (!type || !PLATFORM_EVENT_TYPES.has(type)) return null;

  const rawMetadata = isRecord(raw.metadata) ? raw.metadata : {};
  const rawSubjectType = normalizeSubjectType(asString(raw.subject_type || raw.subjectType));
  const rawSubjectId = asString(raw.subject_id || raw.subjectId);
  let productId = firstString(
    raw.product_id,
    raw.productId,
    raw.productID,
    rawMetadata.product_id,
    rawMetadata.productId
  );
  let videoId = firstString(
    raw.video_id,
    raw.videoId,
    rawMetadata.video_id,
    rawMetadata.videoId,
    rawSubjectType === "video" ? rawSubjectId : ""
  );
  let creatorId = firstString(
    raw.creator_id,
    raw.creatorId,
    rawMetadata.creator_id,
    rawMetadata.creatorId,
    rawSubjectType === "creator" ? rawSubjectId : ""
  );
  const subjectType = rawSubjectType || inferSubjectType(type, { productId, videoId, creatorId });
  const subjectId =
    rawSubjectId ||
    inferSubjectId(subjectType, {
      productId,
      videoId,
      creatorId,
    });

  if (!subjectType || !subjectId) return null;

  if (!productId && subjectType === "product") productId = subjectId;
  if (!videoId && subjectType === "video") videoId = subjectId;
  if (!creatorId && subjectType === "creator") creatorId = subjectId;

  const metadata = normalizeMetadata(raw, rawType);
  const watchMs = asPositiveInt(raw.watch_ms || raw.watchMs);
  const positionMs = asPositiveInt(raw.position_ms || raw.positionMs);
  if (watchMs !== undefined && metadata.watch_ms === undefined) metadata.watch_ms = watchMs;
  if (positionMs !== undefined && metadata.position_ms === undefined) metadata.position_ms = positionMs;
  if (productId && metadata.product_id === undefined) metadata.product_id = productId;
  if (videoId && metadata.video_id === undefined) metadata.video_id = videoId;
  if (creatorId && metadata.creator_id === undefined) metadata.creator_id = creatorId;

  return {
    ...(asString(raw.id) ? { id: asString(raw.id) } : {}),
    type,
    ...(firstString(raw.actor_id, raw.actorId, raw.user_id, raw.userId, sourceSessionId) ? {
      actor_id: firstString(raw.actor_id, raw.actorId, raw.user_id, raw.userId, sourceSessionId),
    } : {}),
    subject_type: subjectType,
    subject_id: subjectId,
    occurred_at: normalizeTimestamp(raw.occurred_at || raw.occurredAt || raw.timestamp),
    ...(videoId ? { video_id: videoId } : {}),
    ...(productId ? { product_id: productId } : {}),
    ...(creatorId ? { creator_id: creatorId } : {}),
    ...(watchMs !== undefined ? { watch_ms: watchMs } : {}),
    ...(positionMs !== undefined ? { position_ms: positionMs } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
}

function normalizeEventType(rawType: string, raw: RawEvent) {
  if (rawType === "watch" && raw.complete === true) return "video_complete";
  return LEGACY_EVENT_TYPE_MAP[rawType] || rawType;
}

function normalizeMetadata(raw: RawEvent, rawType: string) {
  const metadata: Record<string, unknown> = isRecord(raw.metadata) ? { ...raw.metadata } : {};

  for (const key of ["source", "position", "complete", "quantity", "seed"]) {
    if (raw[key] !== undefined) metadata[key] = raw[key];
  }

  if (rawType && !PLATFORM_EVENT_TYPES.has(rawType)) {
    metadata.legacy_type = rawType;
  }

  return metadata;
}

function toGoEvent(event: FeedEvent) {
  return {
    ...(event.id ? { id: event.id } : {}),
    type: event.type,
    ...(event.actor_id ? { actor_id: event.actor_id } : {}),
    subject_type: event.subject_type,
    subject_id: event.subject_id,
    ...(event.occurred_at ? { occurred_at: event.occurred_at } : {}),
    ...(event.metadata && Object.keys(event.metadata).length ? { metadata: event.metadata } : {}),
  };
}

function toLegacyEvent(event: FeedEvent, sessionId: string) {
  const productId = event.product_id || metadataString(event.metadata, "product_id") || (event.subject_type === "product" ? event.subject_id : "");
  const videoId = event.video_id || metadataString(event.metadata, "video_id") || (event.subject_type === "video" ? event.subject_id : "");
  const numericProductId = Number(productId);
  return {
    event_type: event.type,
    subject_id: event.subject_id || videoId || productId || event.type,
    user_id: event.actor_id || sessionId,
    product_id: Number.isFinite(numericProductId) && numericProductId > 0 ? numericProductId : 0,
    video_id: videoId || "",
    metadata: {
      ...(event.metadata || {}),
      subject_type: event.subject_type,
      subject_id: event.subject_id,
      ...(event.occurred_at ? { occurred_at: event.occurred_at } : {}),
    },
  };
}

function inferSubjectType(type: string, ids: { productId: string; videoId: string; creatorId: string }) {
  if (CREATOR_SUBJECT_EVENT_TYPES.has(type)) return "creator";
  if (PRODUCT_SUBJECT_EVENT_TYPES.has(type)) return "product";
  if (ids.videoId) return "video";
  if (ids.productId) return "product";
  if (ids.creatorId) return "creator";
  return "";
}

function inferSubjectId(subjectType: string, ids: { productId: string; videoId: string; creatorId: string }) {
  if (subjectType === "product") return ids.productId;
  if (subjectType === "creator") return ids.creatorId;
  if (subjectType === "video") return ids.videoId || ids.productId;
  return ids.videoId || ids.productId || ids.creatorId;
}

function normalizeSubjectType(value: string) {
  return value.trim().toLowerCase();
}

function normalizeTimestamp(value: unknown) {
  const fallback = new Date().toISOString();
  if (!value) return fallback;

  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function asPositiveInt(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.trunc(number);
}

function asString(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const stringValue = asString(value);
    if (stringValue) return stringValue;
  }
  return "";
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string) {
  if (!metadata) return "";
  return asString(metadata[key]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
