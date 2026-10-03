/**
 * Tipuri minime pentru runtime-ul Workers (R2 binding, Cache API, context),
 * declarate local ca sursa să se verifice și cu tsconfig-ul aplicației
 * (fără dependența @cloudflare/workers-types).
 */

export interface R2HttpMetadataLike {
  contentType?: string;
  cacheControl?: string;
}

export interface R2ObjectLike {
  key: string;
  size: number;
  httpEtag: string;
  httpMetadata?: R2HttpMetadataLike;
  range?: { offset?: number; length?: number; suffix?: number };
  writeHttpMetadata(headers: Headers): void;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream;
}

export interface R2GetOptionsLike {
  range?: Headers;
  onlyIf?: Headers;
}

export interface R2BucketLike {
  get(key: string, options?: R2GetOptionsLike): Promise<R2ObjectBodyLike | R2ObjectLike | null>;
}

export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface MediaWorkerEnv {
  MEDIA_BUCKET: R2BucketLike;
  /** Același secret ca MEDIA_SIGNING_SECRET din aplicație (`wrangler secret put`). */
  MEDIA_SIGNING_SECRET: string;
  /** Prefixul cheilor fără acces direct (implicit `private/`). */
  PRIVATE_PREFIX?: string;
  /** Originile browser permise (CORS), separate prin virgulă. */
  ALLOWED_ORIGINS?: string;
}

export function hasBody(object: R2ObjectBodyLike | R2ObjectLike): object is R2ObjectBodyLike {
  return "body" in object && object.body !== undefined && object.body !== null;
}
