/** Cron: digestul săptămânal — logica și regulile de consimțământ în lib/email/digest-job.ts. */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runCron, cronSkippedResponse } from "@/lib/cron/runCron";
import { runDigest } from "@/lib/email/digest-job";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorize(req: Request): boolean {
  // Acceptă și x-cron-secret (standardul celorlalte joburi), și Bearer.
  const token =
    (req.headers.get("authorization") || "").replace("Bearer ", "") ||
    req.headers.get("x-cron-secret") ||
    "";
  const expected = process.env.CRON_SECRET || "";
  if (!expected || !token) return false;
  if (Buffer.byteLength(token) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export async function POST(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await runCron("email-digest", runDigest);
  if (result === null) return cronSkippedResponse("email-digest");
  return NextResponse.json({ ok: true, ...result });
}

export async function GET(req: Request) {
  return POST(req);
}
