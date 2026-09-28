import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { dbQuery } from "@/lib/db";
import { readStorageSettings } from "@/lib/storage/config";
import { getS3Client } from "@/lib/storage/s3-client";
import { videoQueueBackend } from "@/lib/queue/video-jobs";

export type HealthStatus = "ok" | "degraded" | "error";

export interface HealthResult {
  status: HealthStatus;
  latency_ms: number;
  detail: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 2_000;

export async function withLatency<T>(fn: () => Promise<T>): Promise<{ value: T; latency_ms: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, latency_ms: Date.now() - start };
}

export function jsonDetail(error: unknown): Record<string, string> {
  if (error instanceof Error) return { error: error.message };
  return { error: "unknown error" };
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("health check timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checkDb(): Promise<HealthResult> {
  try {
    const { latency_ms } = await withLatency(() => withTimeout(dbQuery("SELECT 1"), 1_500));
    return {
      status: latency_ms > 500 ? "degraded" : "ok",
      latency_ms,
      detail: latency_ms > 500 ? { reason: "slow query" } : {},
    };
  } catch (error) {
    return { status: "error", latency_ms: 0, detail: jsonDetail(error) };
  }
}

export async function checkRedis(): Promise<HealthResult> {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const { latency_ms } = await withLatency(async () => {
        const { Redis } = await import("@upstash/redis");
        const redis = new Redis({
          url: process.env.UPSTASH_REDIS_REST_URL!,
          token: process.env.UPSTASH_REDIS_REST_TOKEN!,
        });
        await withTimeout(redis.ping(), 1_500);
      });
      return { status: "ok", latency_ms, detail: { backend: "upstash" } };
    } catch (error) {
      return { status: "error", latency_ms: 0, detail: { backend: "upstash", ...jsonDetail(error) } };
    }
  }

  if (!process.env.REDIS_URL) {
    return { status: "degraded", latency_ms: 0, detail: { reason: "not_configured" } };
  }

  try {
    const { latency_ms } = await withLatency(() => redisRequest(process.env.REDIS_URL!, [["PING"]], 1_500));
    return { status: "ok", latency_ms, detail: { backend: "native" } };
  } catch (error) {
    return { status: "error", latency_ms: 0, detail: { backend: "native", ...jsonDetail(error) } };
  }
}

export async function checkR2(): Promise<HealthResult> {
  const settings = readStorageSettings();
  if (!settings) {
    return { status: "degraded", latency_ms: 0, detail: { reason: "not_configured" } };
  }

  try {
    const { latency_ms } = await withLatency(() =>
      withTimeout(getS3Client().send(new HeadBucketCommand({ Bucket: settings.bucket })), 2_000)
    );
    return { status: "ok", latency_ms, detail: { bucket_configured: true } };
  } catch (error) {
    return { status: "error", latency_ms: 0, detail: jsonDetail(error) };
  }
}

export async function checkQueue(): Promise<HealthResult> {
  // Coada video implicită e în Postgres (lib/queue/video-jobs.ts).
  if (videoQueueBackend() === "postgres") return (await import("@/lib/queue/video-queue-health")).checkPgQueue();
  return _checkQueue();
}

/** Provider email activ + verificare conexiune (SMTP face verify real). */
export async function checkEmail(): Promise<HealthResult> {
  const start = Date.now();
  try {
    const { verifyTransport } = await import("@/lib/email/transport");
    const res = await withTimeout(verifyTransport(), 5000);
    const latency_ms = Date.now() - start;
    if (!res.ok) {
      return {
        status: res.provider === "none" ? "degraded" : "error",
        latency_ms,
        detail: { provider: res.provider, ...(res.error ? { error: res.error } : { reason: "not_configured" }) },
      };
    }
    return { status: "ok", latency_ms, detail: { provider: res.provider } };
  } catch (err) {
    return { status: "error", latency_ms: Date.now() - start, detail: { error: (err as Error).message } };
  }
}

async function _checkQueue(): Promise<HealthResult> {
  const queueName = process.env.VIDEO_QUEUE_NAME || process.env.REDIS_STREAM_VIDEO_JOBS || "video:jobs";
  const failedName = process.env.VIDEO_FAILED_STREAM || `${queueName}:failed`;

  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const { latency_ms, value } = await withLatency(async () => {
        const { Redis } = await import("@upstash/redis");
        const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
        const [length, failed] = await withTimeout(Promise.all([redis.xlen(queueName), redis.xlen(failedName)]), 1_500);
        return { length: Number(length || 0), failed: Number(failed || 0) };
      });
      return queueResult(value.length, value.failed, 0, 0, latency_ms, queueName, failedName, process.env.VIDEO_CONSUMER_GROUP || "video-workers");
    } catch (error) {
      return { status: "error", latency_ms: 0, detail: jsonDetail(error) };
    }
  }

  if (!process.env.REDIS_URL) {
    return { status: "degraded", latency_ms: 0, detail: { reason: "redis_not_configured", queue: queueName } };
  }

  const groupName = process.env.VIDEO_CONSUMER_GROUP || "video-workers";
  try {
    const { latency_ms, value } = await withLatency(async () => {
      const replies = await redisRequest(
        process.env.REDIS_URL!,
        [
          ["XLEN", queueName],
          ["XLEN", failedName],
          ["XPENDING", queueName, groupName],
          ["XINFO", "GROUPS", queueName],
        ],
        1_500,
      );
      const length = Number(replies[0] || 0);
      const failed = Number(replies[1] || 0);
      const xpending = replies[2] as unknown;
      // XPENDING summary returns array [pending_count, min_id, max_id, [[consumer, count], ...]]
      let pending = 0;
      if (Array.isArray(xpending) && xpending[0] != null) pending = Number(xpending[0] || 0);
      // XINFO GROUPS returns array of group property arrays; find lag for our group
      let lag = 0;
      const groups = Array.isArray(replies[3]) ? (replies[3] as unknown[]) : [];
      for (const g of groups) {
        if (!Array.isArray(g)) continue;
        const arr = g as unknown[];
        let name: string | null = null;
        let lagVal: number | null = null;
        for (let i = 0; i < arr.length - 1; i += 2) {
          const k = String(arr[i]);
          if (k === "name") name = String(arr[i + 1]);
          else if (k === "lag") lagVal = Number(arr[i + 1] || 0);
        }
        if (name === groupName && lagVal != null) lag = lagVal;
      }
      return { length, failed, pending, lag };
    });
    return queueResult(value.length, value.failed, value.pending, value.lag, latency_ms, queueName, failedName, groupName);
  } catch (error) {
    return { status: "error", latency_ms: 0, detail: jsonDetail(error) };
  }
}

function queueResult(length: number, failed: number, pending: number, lag: number, latency_ms: number, queue: string, failedQueue: string, group: string): HealthResult {
  const status: HealthStatus = failed > 100 || lag > 10_000 || pending > 500 ? "degraded" : "ok";
  return { status, latency_ms, detail: { queue, failed_queue: failedQueue, group, length, failed, pending, lag } };
}

export async function redisRequest(rawURL: string, commands: string[][], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown[]> {
  const parsed = new URL(rawURL);
  const secure = parsed.protocol === "rediss:";
  if (parsed.protocol !== "redis:" && !secure) throw new Error("unsupported redis URL protocol");

  const host = parsed.hostname || "localhost";
  const port = Number(parsed.port || (secure ? 6380 : 6379));
  const password = decodeURIComponent(parsed.password || "");
  const username = decodeURIComponent(parsed.username || "");
  const auth = password ? [username ? ["AUTH", username, password] : ["AUTH", password]] : [];
  const payload = [...auth, ...commands].map(redisCommand).join("");

  const net = await import("node:net");
  const tls = secure ? await import("node:tls") : null;

  return await new Promise<unknown[]>((resolve, reject) => {
    const socket = secure ? tls!.connect({ host, port, servername: host }) : net.createConnection({ host, port });
    let buffer = "";
    let settled = false;
    const replies: unknown[] = [];
    const expectedReplies = commands.length + auth.length;

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (err) reject(err);
      else resolve(replies.slice(auth.length));
    };

    const timeout = setTimeout(() => done(new Error("redis command timeout")), timeoutMs);
    socket.once(secure ? "secureConnect" : "connect", () => socket.write(payload));
    socket.once("error", (err) => done(err));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      try {
        const parsedReplies = parseRedisReplies(buffer);
        replies.splice(0, replies.length, ...parsedReplies);
        if (replies.length >= expectedReplies) done();
      } catch (error) {
        done(error as Error);
      }
    });
  });
}

function parseRedisReplies(buffer: string): unknown[] {
  const replies: unknown[] = [];
  let index = 0;
  while (index < buffer.length) {
    const parsed = parseReply(buffer, index);
    if (!parsed) break;
    replies.push(parsed.value);
    index = parsed.next;
  }
  return replies;
}

function parseReply(buffer: string, index: number): { value: unknown; next: number } | null {
  const lineEnd = buffer.indexOf("\r\n", index);
  if (lineEnd === -1) return null;
  const line = buffer.slice(index, lineEnd);
  const type = line[0];
  const data = line.slice(1);
  const next = lineEnd + 2;
  if (type === "+") return { value: data, next };
  if (type === ":") return { value: Number(data), next };
  if (type === "-") throw new Error(data || "redis error");
  if (type === "$") {
    const len = Number(data);
    if (len < 0) return { value: null, next };
    if (buffer.length < next + len + 2) return null;
    return { value: buffer.slice(next, next + len), next: next + len + 2 };
  }
  if (type === "*") {
    const count = Number(data);
    if (count < 0) return { value: null, next };
    const items: unknown[] = [];
    let cursor = next;
    for (let i = 0; i < count; i++) {
      const child = parseReply(buffer, cursor);
      if (!child) return null;
      items.push(child.value);
      cursor = child.next;
    }
    return { value: items, next: cursor };
  }
  throw new Error("unsupported redis reply");
}

function redisCommand(parts: string[]): string {
  return `*${parts.length}\r\n${parts.map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`).join("")}`;
}
