/**
 * Health Check Endpoint — GET /api/health
 *
 * Public (no auth). Checks: DB, Redis (optional), Storage (real R2 HeadBucket).
 * Reports release metadata (commit, build_time) for deploy auditability.
 */

import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { checkR2, checkEmail } from "@/lib/health";
import { releaseInfo, replicaInfo } from "@/lib/runtime/replica";

const APP_VERSION = "0.1.0";

export const dynamic = "force-dynamic";

export async function GET() {
  const services: Record<string, unknown> = {
    database: "ok",
    redis: "not_configured",
    storage: "not_configured",
  };

  // --- a. Database connection ---
  try {
    await dbQuery("SELECT 1");
  } catch {
    services.database = "error";
  }

  // --- b. Redis ping (only if configured) ---
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const { Redis } = await import("@upstash/redis");
      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });
      await redis.ping();
      services.redis = "ok";
    } catch {
      services.redis = "error";
    }
  } else if (process.env.REDIS_URL) {
    try {
      await pingRedisURL(process.env.REDIS_URL);
      services.redis = "ok";
    } catch {
      services.redis = "error";
    }
  }

  // --- c. Storage (real R2 HeadBucket via shared lib) ---
  try {
    const r2 = await checkR2();
    services.storage = {
      ok: r2.status === "ok",
      status: r2.status,
      latency_ms: r2.latency_ms,
      ...r2.detail,
    };
  } catch (err) {
    services.storage = { ok: false, status: "error", error: String(err) };
  }

  // --- d. Email (Resend sau SMTP) ---
  try {
    const mail = await checkEmail();
    services.email = {
      ok: mail.status === "ok",
      status: mail.status,
      latency_ms: mail.latency_ms,
      ...mail.detail,
    };
  } catch (err) {
    services.email = { ok: false, status: "error", error: String(err) };
  }

  const status = services.database === "error" ? "degraded" : "healthy";

  const release = releaseInfo();

  return NextResponse.json(
    {
      status,
      timestamp: new Date().toISOString(),
      version: APP_VERSION,
      release,
      // Replica care a răspuns (hostname-ul containerului) — cu N replici în
      // spatele tunelului, arată care instanță servește și ce commit rulează.
      replica: replicaInfo(),
      services,
      uptime: process.uptime(),
    },
    { status: status === "healthy" ? 200 : 503 }
  );
}

async function pingRedisURL(rawURL: string): Promise<void> {
  const parsed = new URL(rawURL);
  const secure = parsed.protocol === "rediss:";
  if (parsed.protocol !== "redis:" && !secure) {
    throw new Error("unsupported redis URL protocol");
  }

  const host = parsed.hostname || "localhost";
  const port = Number(parsed.port || (secure ? 6380 : 6379));
  const password = decodeURIComponent(parsed.password || "");
  const username = decodeURIComponent(parsed.username || "");
  const commands = [
    ...(password ? [redisCommand(username ? ["AUTH", username, password] : ["AUTH", password])] : []),
    redisCommand(["PING"]),
  ].join("");

  const net = await import("node:net");
  const tls = secure ? await import("node:tls") : null;

  await new Promise<void>((resolve, reject) => {
    const socket = secure
      ? tls!.connect({ host, port, servername: host })
      : net.createConnection({ host, port });
    let buffer = "";
    let settled = false;

    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    const timeout = setTimeout(() => done(new Error("redis ping timeout")), 2_000);
    const readyEvent = secure ? "secureConnect" : "connect";

    socket.once(readyEvent, () => socket.write(commands));
    socket.once("error", (err) => done(err));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("+PONG") || buffer.includes("$4\r\nPONG")) {
        done();
      } else if (buffer.startsWith("-")) {
        done(new Error(buffer.split("\r\n")[0]));
      }
    });
  });
}

function redisCommand(parts: string[]): string {
  return `*${parts.length}\r\n${parts
    .map((part) => `$${Buffer.byteLength(part)}\r\n${part}\r\n`)
    .join("")}`;
}
