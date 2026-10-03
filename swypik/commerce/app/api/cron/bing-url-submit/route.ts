// /api/cron/bing-url-submit — Bing URL Submission API (10k URLs/day, verified site).
// Auth: Bearer ${CRON_SECRET}. Body { urls: [...] } optional for ad-hoc.
import { withCronLock } from "@/lib/cron/lock";
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { timingSafeEqual } from "node:crypto";
import { APP_URL } from "@/lib/app-url";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BASE_URL = APP_URL;
const SITE_URL = BASE_URL.endsWith("/") ? BASE_URL : `${BASE_URL}/`;
const BING_ENDPOINT = "https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlBatch";

function authOk(token: string | null | undefined): boolean {
  const expected = process.env.CRON_SECRET || "";
  if (!token || !expected) return false;
  if (Buffer.byteLength(token) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

async function collectUrls(limit: number): Promise<string[]> {
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
        ORDER BY updated_at DESC NULLS LAST LIMIT 5000`,
    );
    for (const r of rows as Array<{ id: string }>) urls.push(`${BASE_URL}/product/${r.id}`);
  } catch { /* ignore */ }

  try {
    const { rows } = await dbQuery(
      `SELECT id FROM videos WHERE status='ready' AND visibility='public'
        AND COALESCE(is_hidden, false)=false AND effective_label='safe'
       ORDER BY published_at DESC NULLS LAST LIMIT 1000`,
    );
    for (const r of rows as Array<{ id: string }>) urls.push(`${BASE_URL}/video/${r.id}`);
  } catch { /* ignore */ }

  try {
    const { rows } = await dbQuery(
      `SELECT slug FROM taxonomy_nodes WHERE slug IS NOT NULL LIMIT 500`,
    );
    for (const r of rows as Array<{ slug: string }>) urls.push(`${BASE_URL}/categories/${r.slug}`);
  } catch { /* ignore */ }

  return Array.from(new Set(urls)).slice(0, limit);
}

async function submitBatch(key: string, batch: string[]) {
  const res = await fetch(`${BING_ENDPOINT}?apikey=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ siteUrl: SITE_URL, urlList: batch }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) } as Response));
  let text = "";
  try { text = await res.text(); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, body: text.slice(0, 400) };
}

function bearer(req: Request): string | null {
  const auth = req.headers.get("authorization") || "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
}

/** Exact-once între replici: autentificare întâi, apoi lock (o rulare concurentă → 200 skipped). */
export async function POST(req: Request) {
  if (!authOk(bearer(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return withCronLock("bing-url-submit", () => submitUrls(req));
}

/** Rulează doar sub lock, după autentificarea din POST. */
async function submitUrls(req: Request): Promise<Response> {

  const key = process.env.BING_URL_SUBMISSION_API_KEY;
  if (!key) return NextResponse.json({ error: "no_key" }, { status: 500 });

  const url = new URL(req.url);
  const dailyCap = Math.min(Number(url.searchParams.get("limit") || 500), 9500); // Bing daily quota — starts 500, grows over time

  let bodyUrls: string[] = [];
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      const j = (await req.json().catch(() => null)) as { urls?: string[] } | null;
      if (Array.isArray(j?.urls)) bodyUrls = j!.urls.filter((u) => typeof u === "string" && u.startsWith(BASE_URL));
    }
  } catch { /* ignore */ }

  const urls = bodyUrls.length > 0 ? bodyUrls.slice(0, dailyCap) : await collectUrls(dailyCap);
  if (urls.length === 0) return NextResponse.json({ ok: true, submitted: 0 });

  // Smaller batches to fit varying daily quota (new sites start at ~500/day)
  const BATCH = 100;
  const results: Array<{ batch: number; status: number; ok: boolean; body?: string; remaining?: number }> = [];
  let submitted = 0;
  let stop = false;
  for (let i = 0; i < urls.length && !stop; i += BATCH) {
    let slice = urls.slice(i, i + BATCH);
    let r = await submitBatch(key, slice);
    let remaining: number | undefined;
    if (!r.ok && r.status === 400 && /Quota remaining for today/.test(r.body)) {
      const m = r.body.match(/Quota remaining for today:\s*(\d+)/);
      remaining = m ? Number(m[1]) : 0;
      if (remaining > 0) {
        slice = slice.slice(0, remaining);
        r = await submitBatch(key, slice);
      }
      stop = true; // out of quota after this attempt
    }
    results.push({ batch: i / BATCH + 1, status: r.status, ok: r.ok, body: r.ok ? undefined : r.body.slice(0, 200), remaining });
    if (r.ok) submitted += slice.length;
    if (!r.ok && r.status === 403) break;
  }

  return NextResponse.json({ ok: true, total: urls.length, submitted, batches: results });
}

export async function GET(req: Request) { return POST(req); }
