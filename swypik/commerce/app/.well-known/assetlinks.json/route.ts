/**
 * GET /.well-known/assetlinks.json — Android App Links (Digital Asset Links).
 * Conținut din env (lib/mobile/app-links.ts); 404 cât timp nu e configurat.
 */
import { NextResponse } from "next/server";
import { androidAssetLinks } from "@/lib/mobile/app-links";

export const dynamic = "force-dynamic";

export function GET() {
  const body = androidAssetLinks();
  if (!body) return new NextResponse(null, { status: 404 });
  return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=3600" } });
}
