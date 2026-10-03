import { buildCreatorSnapshot, DEFAULT_CREATOR_ID, normalizeCreatorId } from "./creator";
import { getSocialApiBaseUrl } from "./proxy";

type FetchResult = {
  payload: unknown;
  source: string;
};

export async function getCreatorSnapshotForRequest(req: Request, creatorId: string) {
  const url = new URL(req.url);
  const normalizedCreatorId = normalizeCreatorId(creatorId === "me" ? DEFAULT_CREATOR_ID : creatorId);
  const limit = boundedInt(url.searchParams.get("limit"), 48, 1, 100);

  const feedResult =
    (await fetchGoCreatorFeed(req, normalizedCreatorId, limit)) ||
    (await fetchLocalCreatorFeed(req, normalizedCreatorId, limit));

  return buildCreatorSnapshot({
    creatorId: normalizedCreatorId,
    feedPayload: feedResult?.payload,
    source: feedResult?.source || "creator-feed-empty",
  });
}

async function fetchGoCreatorFeed(req: Request, creatorId: string, limit: number): Promise<FetchResult | null> {
  const baseUrl = getSocialApiBaseUrl();
  if (!baseUrl) return null;

  const upstreamUrl = new URL("v1/feed", baseUrl);
  upstreamUrl.searchParams.set("creator_id", creatorId);
  upstreamUrl.searchParams.set("limit", String(limit));

  const headers = requestForwardHeaders(req);
  const response = await fetch(upstreamUrl, {
    headers,
    cache: "no-store",
  }).catch(() => null);
  if (!response?.ok) return null;

  const payload = await response.json().catch(() => null);
  return { payload, source: "go-social-api" };
}

async function fetchLocalCreatorFeed(req: Request, creatorId: string, limit: number): Promise<FetchResult | null> {
  const localUrl = new URL("/api/v1/feed", req.url);
  localUrl.searchParams.set("creator_id", creatorId);
  localUrl.searchParams.set("limit", String(limit));

  const response = await fetch(localUrl, {
    headers: requestForwardHeaders(req),
    cache: "no-store",
  }).catch(() => null);
  if (!response?.ok) return null;

  const payload = await response.json().catch(() => null);
  return { payload, source: "next-feed-fallback" };
}

function requestForwardHeaders(req: Request) {
  const headers = new Headers();
  const authorization = req.headers.get("authorization");
  const cookie = req.headers.get("cookie");
  if (authorization) headers.set("authorization", authorization);
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

function boundedInt(raw: string | null, fallback: number, low: number, high: number) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(low, Math.min(Math.trunc(value), high));
}
