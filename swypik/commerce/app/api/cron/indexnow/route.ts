// /opt/swypik/app/app/api/cron/indexnow/route.ts
// Real-time URL submission to Bing + Yandex via IndexNow protocol.
// Auth: Bearer ${CRON_SECRET}. Accepts ad-hoc body { urls: [...] } for live push.
import { withCronLock } from "@/lib/cron/lock";
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { timingSafeEqual } from "node:crypto";
import { APP_URL } from "@/lib/app-url";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BASE_URL = APP_URL;
const HOST = new URL(BASE_URL).host;

function ok(token: string | null | undefined): boolean {
  const expected = process.env.CRON_SECRET || "";
  if (!token || !expected) return false;
  if (Buffer.byteLength(token) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

async function fetchUrls(limit: number): Promise<string[]> {
  const urls: string[] = [
    `${BASE_URL}/`,
    `${BASE_URL}/explore`,
    `${BASE_URL}/search`,
    `${BASE_URL}/become-a-creator`,
    `${BASE_URL}/become-a-seller`,
  ];

  try {
    const { rows } = await dbQuery(
      `SELECT id FROM marketplace_products
        WHERE status='active' AND effective_label='safe' AND is_adult=false
        ORDER BY updated_at DESC NULLS LAST LIMIT 2000`,
    );
    for (const r of rows as Array<{ id: string }>) urls.push(`${BASE_URL}/product/${r.id}`);
  } catch (e) { /* ignore */ }

  try {
    const { rows } = await dbQuery(
      `SELECT id FROM videos WHERE status='ready' AND visibility='public'
        AND COALESCE(is_hidden, false)=false AND effective_label='safe'
       ORDER BY published_at DESC NULLS LAST LIMIT 500`,
    );
    for (const r of rows as Array<{ id: string }>) urls.push(`${BASE_URL}/video/${r.id}`);
  } catch (e) { /* ignore */ }

  return Array.from(new Set(urls)).slice(0, limit);
}

async function submit(endpoint: string, key: string, urls: string[]) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: HOST,
      key,
      keyLocation: `${BASE_URL}/${key}.txt`,
      urlList: urls,
    }),
  }).catch(() => null);
  if (!res) return { ok: false, status: 0 };
  return { ok: res.ok, status: res.status };
}

function bearer(req: Request): string | null {
  const auth = req.headers.get("authorization") || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
}

/** Exact-once între replici: autentificare întâi, apoi lock (o rulare concurentă → 200 skipped). */
export async function POST(req: Request) {
  if (!ok(bearer(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return withCronLock("indexnow", () => submitUrls(req));
}

/** Rulează doar sub lock, după autentificarea din POST. */
async function submitUrls(req: Request): Promise<Response> {

  const key = process.env.INDEXNOW_KEY;
  if (!key) return NextResponse.json({ error: "no_key" }, { status: 500 });

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || 3000), 9000);

  let bodyUrls: string[] = [];
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      const j = (await req.json().catch(() => null)) as { urls?: string[] } | null;
      if (Array.isArray(j?.urls)) bodyUrls = j!.urls.filter((u) => typeof u === "string");
    }
  } catch { /* ignore */ }

  const urls = bodyUrls.length > 0 ? bodyUrls.slice(0, 9000) : await fetchUrls(limit);
  if (urls.length === 0) return NextResponse.json({ ok: true, submitted: 0 });

  const bing = await submit("https://api.indexnow.org/IndexNow", key, urls);
  const yandex = await submit("https://yandex.com/indexnow", key, urls);

  return NextResponse.json({
    ok: true,
    submitted: urls.length,
    bing: { ok: bing.ok, status: bing.status },
    yandex: { ok: yandex.ok, status: yandex.status },
  });
}

export async function GET(req: Request) { return POST(req); }
