export const DEFAULT_CREATOR_ID = "web-creator";

export type CreatorVideoStatus =
  | "ready"
  | "processing"
  | "uploading"
  | "completed"
  | "draft"
  | "poster_only"
  | "unknown";

export type CreatorVideo = {
  id: string;
  creatorId: string;
  productId: string;
  title: string;
  status: CreatorVideoStatus;
  videoUrl: string;
  posterUrl: string;
  views: number;
  likes: number;
  comments: number;
  orders: number;
  cartAdds: number;
  productClicks: number;
  watchMs: number;
  rankScore: number;
  publishedAt: string;
};

export type CreatorProfileSummary = {
  id: string;
  username: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
};

export type CreatorStats = {
  videos: number;
  readyVideos: number;
  processingVideos: number;
  views: number;
  likes: number;
  comments: number;
  orders: number;
  cartAdds: number;
  productClicks: number;
  watchMs: number;
  eventCount: number;
};

export type CreatorSnapshot = {
  creator: CreatorProfileSummary;
  stats: CreatorStats;
  videos: CreatorVideo[];
  placeholders: {
    eventStats: boolean;
    uploadStats: boolean;
    reason: string;
  };
  source: string;
  generatedAt: string;
};

export type CreatorUploadStatus = {
  id: string;
  creatorId: string;
  productId: string;
  filename: string;
  status: CreatorVideoStatus;
  videoId: string;
  sizeBytes: number;
  createdAt: string;
  completedAt: string;
  expiresAt: string;
};

type SnapshotInput = {
  creatorId?: string | null;
  feedPayload?: unknown;
  eventsPayload?: unknown;
  generatedAt?: string;
  source?: string;
};

type EventStats = {
  eventCount: number;
  views: number;
  likes: number;
  comments: number;
  cartAdds: number;
  productClicks: number;
  watchMs: number;
};

export function normalizeCreatorId(value: unknown, fallback = DEFAULT_CREATOR_ID) {
  const raw = asString(value).replace(/^@+/, "").trim();
  const normalized = raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

  return normalized || fallback;
}

export function buildCreatorSnapshot(input: SnapshotInput): CreatorSnapshot {
  const creatorId = normalizeCreatorId(input.creatorId);
  const items = extractFeedItems(input.feedPayload)
    .map(normalizeCreatorVideo)
    .filter((item): item is CreatorVideo => Boolean(item))
    .filter((item) => normalizeCreatorId(item.creatorId, "") === creatorId);

  const sortedVideos = items.sort(compareCreatorVideos);
  const profile = profileFromFeedItem(creatorId, sortedVideos[0], input.feedPayload);
  const eventStats = extractEventStats(input.eventsPayload, creatorId);
  const stats = sortedVideos.reduce<CreatorStats>(
    (acc, video) => {
      acc.videos += 1;
      if (video.status === "ready") acc.readyVideos += 1;
      if (isProcessingStatus(video.status)) acc.processingVideos += 1;
      acc.views += video.views;
      acc.likes += video.likes;
      acc.comments += video.comments;
      acc.orders += video.orders;
      acc.cartAdds += video.cartAdds;
      acc.productClicks += video.productClicks;
      acc.watchMs += video.watchMs;
      return acc;
    },
    {
      videos: 0,
      readyVideos: 0,
      processingVideos: 0,
      views: 0,
      likes: 0,
      comments: 0,
      orders: 0,
      cartAdds: 0,
      productClicks: 0,
      watchMs: 0,
      eventCount: eventStats.eventCount,
    }
  );

  stats.views += eventStats.views;
  stats.likes += eventStats.likes;
  stats.comments += eventStats.comments;
  stats.cartAdds += eventStats.cartAdds;
  stats.productClicks += eventStats.productClicks;
  stats.watchMs += eventStats.watchMs;

  return {
    creator: profile,
    stats,
    videos: sortedVideos,
    placeholders: {
      eventStats: eventStats.eventCount === 0,
      uploadStats: true,
      reason: "Creator analytics v1 uses feed counters plus write-only event acknowledgements until event rollups are queryable.",
    },
    source: input.source || feedSource(input.feedPayload),
    generatedAt: input.generatedAt || new Date().toISOString(),
  };
}

export function normalizeUploadStatus(raw: unknown): CreatorUploadStatus {
  const source = isRecord(raw) && isRecord(raw.upload) ? raw.upload : raw;
  const record = isRecord(source) ? source : {};
  return {
    id: firstString(record.id, record.upload_id, record.uploadId),
    creatorId: normalizeCreatorId(firstString(record.creator_id, record.creatorId, record.user_id, record.userId)),
    productId: firstString(record.product_id, record.productId),
    filename: firstString(record.filename, record.original_name, record.originalName, "Untitled upload"),
    status: normalizeVideoStatus(firstString(record.status)),
    videoId: firstString(record.video_id, record.videoId),
    sizeBytes: asNonNegativeInt(firstValue(record.size_bytes, record.sizeBytes, record.byte_size, record.byteSize)),
    createdAt: normalizeDateString(firstValue(record.created_at, record.createdAt)),
    completedAt: normalizeDateString(firstValue(record.completed_at, record.completedAt)),
    expiresAt: normalizeDateString(firstValue(record.expires_at, record.expiresAt)),
  };
}

export function normalizeCreatorVideo(raw: unknown): CreatorVideo | null {
  if (!isRecord(raw)) return null;

  const creator = isRecord(raw.creator) ? raw.creator : {};
  const product = isRecord(raw.product) ? raw.product : {};
  const video = isRecord(raw.video) ? raw.video : {};
  const stats = isRecord(raw.stats) ? raw.stats : {};
  const ranking = isRecord(raw.ranking) ? raw.ranking : {};

  const id = firstString(raw.id, raw.video_id, raw.videoId, video.id, video.video_id, video.videoId);
  if (!id) return null;

  const videoUrl = firstString(
    raw.video_url,
    raw.videoUrl,
    raw.video,
    video.video_url,
    video.videoUrl,
    video.mp4Url,
    video.hlsUrl,
    video.url,
    product.video
  );
  const hasVideo = asBoolean(firstValue(raw.has_video, raw.hasVideo)) || videoUrl !== "";
  const rawStatus = firstString(raw.status, video.status, product.status);

  return {
    id,
    creatorId: firstString(raw.creator_id, raw.creatorId, creator.id, product.creator_id, product.creatorId),
    productId: firstString(raw.product_id, raw.productId, product.product_id, product.productId, product.id),
    title: firstString(raw.title, video.title, product.title, "Untitled clip"),
    status: normalizeVideoStatus(rawStatus, hasVideo),
    videoUrl,
    posterUrl: firstString(
      raw.poster_url,
      raw.posterUrl,
      raw.thumbnail_url,
      raw.thumbnailUrl,
      video.posterUrl,
      video.poster_url,
      video.thumbnailUrl,
      product.posterUrl,
      firstImage(product.images)
    ),
    views: asNonNegativeInt(firstValue(raw.views_count, raw.view_count, raw.viewsCount, stats.views, stats.views_count)),
    likes: asNonNegativeInt(firstValue(raw.likes_count, raw.like_count, raw.likesCount, stats.likes, product.likes)),
    comments: asNonNegativeInt(firstValue(raw.comments_count, raw.comment_count, raw.commentsCount, stats.comments, product.commentCount)),
    orders: asNonNegativeInt(firstValue(raw.orders_count, raw.order_count, raw.ordersCount, stats.orders, product.orders)),
    cartAdds: asNonNegativeInt(firstValue(raw.cart_adds, raw.cartAdds, stats.cartAdds, stats.cart_adds)),
    productClicks: asNonNegativeInt(firstValue(raw.product_clicks, raw.productClicks, stats.productClicks, stats.product_clicks)),
    watchMs: asNonNegativeInt(firstValue(raw.watch_ms, raw.watchMs, stats.watchMs, stats.watch_ms)),
    rankScore: asNumber(firstValue(raw.rank_score, raw.rankScore, ranking.score)),
    publishedAt: normalizeDateString(firstValue(raw.published_at, raw.publishedAt, raw.created_at, raw.createdAt)),
  };
}

function extractFeedItems(payload: unknown): unknown[] {
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.items)) return payload.items;
  if (isRecord(payload.data) && Array.isArray(payload.data.items)) return payload.data.items;
  if (Array.isArray(payload.videos)) return payload.videos;
  if (Array.isArray(payload.products)) return payload.products;
  return [];
}

function extractEventStats(payload: unknown, creatorId: string): EventStats {
  const events = extractEvents(payload);
  return events.reduce<EventStats>(
    (acc, event) => {
      if (!eventBelongsToCreator(event, creatorId)) return acc;
      acc.eventCount += 1;
      const type = firstString(event.type, event.event_type, event.eventType);
      if (type === "video_impression") acc.views += 1;
      if (type === "video_like") acc.likes += 1;
      if (type === "comment_create") acc.comments += 1;
      if (type === "add_to_cart") acc.cartAdds += 1;
      if (type === "product_click") acc.productClicks += 1;
      acc.watchMs += asNonNegativeInt(firstValue(event.watch_ms, event.watchMs, isRecord(event.metadata) ? event.metadata.watch_ms : undefined));
      return acc;
    },
    { eventCount: 0, views: 0, likes: 0, comments: 0, cartAdds: 0, productClicks: 0, watchMs: 0 }
  );
}

function extractEvents(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.events)) return payload.events.filter(isRecord);
  if (Array.isArray(payload.items)) return payload.items.filter(isRecord);
  return [];
}

function eventBelongsToCreator(event: Record<string, unknown>, creatorId: string) {
  const metadata = isRecord(event.metadata) ? event.metadata : {};
  const eventCreatorId = normalizeCreatorId(
    firstString(event.creator_id, event.creatorId, metadata.creator_id, metadata.creatorId),
    ""
  );
  if (eventCreatorId) return eventCreatorId === creatorId;

  const subjectType = firstString(event.subject_type, event.subjectType);
  if (subjectType !== "creator") return false;
  return normalizeCreatorId(firstString(event.subject_id, event.subjectId), "") === creatorId;
}

function profileFromFeedItem(creatorId: string, firstVideo: CreatorVideo | undefined, payload: unknown): CreatorProfileSummary {
  const payloadCreator = isRecord(payload) && isRecord(payload.creator) ? payload.creator : {};
  const displayName = firstString(
    payloadCreator.displayName,
    payloadCreator.display_name,
    payloadCreator.username,
    firstVideo?.creatorId ? labelFromCreatorId(firstVideo.creatorId) : "",
    labelFromCreatorId(creatorId)
  );
  const username = normalizeCreatorId(firstString(payloadCreator.username, creatorId));

  return {
    id: creatorId,
    username,
    handle: `@${username}`,
    displayName,
    avatarUrl: firstString(payloadCreator.avatarUrl, payloadCreator.avatar_url) || null,
  };
}

function normalizeVideoStatus(raw: string, hasVideo = false): CreatorVideoStatus {
  const status = raw.toLowerCase().trim();
  if (status === "ready" || status === "published") return "ready";
  if (status === "completed" || status === "complete") return "completed";
  if (status === "processing" || status === "transcoding" || status === "queued") return "processing";
  if (status === "uploading" || status === "pending") return "uploading";
  if (status === "draft" || status === "unlisted" || status === "private") return "draft";
  if (status === "poster_only") return "poster_only";
  if (hasVideo) return "ready";
  return "unknown";
}

function isProcessingStatus(status: CreatorVideoStatus) {
  return status === "processing" || status === "uploading" || status === "completed" || status === "draft";
}

function compareCreatorVideos(a: CreatorVideo, b: CreatorVideo) {
  const aTime = Date.parse(a.publishedAt);
  const bTime = Date.parse(b.publishedAt);
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
  if (Number.isFinite(aTime) && !Number.isFinite(bTime)) return -1;
  if (!Number.isFinite(aTime) && Number.isFinite(bTime)) return 1;
  if (a.rankScore !== b.rankScore) return b.rankScore - a.rankScore;
  return a.id.localeCompare(b.id);
}

function feedSource(payload: unknown) {
  if (isRecord(payload) && asString(payload.source)) return asString(payload.source);
  return "creator-feed";
}

function labelFromCreatorId(id: string) {
  const normalized = normalizeCreatorId(id);
  return normalized
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeDateString(value: unknown) {
  const raw = asString(value);
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function firstImage(value: unknown) {
  return Array.isArray(value) ? firstString(...value) : "";
}

function firstValue(...values: unknown[]) {
  return values.find((value) => value !== null && value !== undefined && value !== "");
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const stringValue = asString(value);
    if (stringValue) return stringValue;
  }
  return "";
}

function asString(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function asNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function asNonNegativeInt(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.trunc(number);
}

function asBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return Boolean(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
