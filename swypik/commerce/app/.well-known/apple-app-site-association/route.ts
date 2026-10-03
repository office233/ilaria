/**
 * GET /.well-known/apple-app-site-association — Universal Links iOS.
 * Conținut din env (lib/mobile/app-links.ts); 404 cât timp nu e configurat.
 */
import { NextResponse } from "next/server";
import { appleAppSiteAssociation } from "@/lib/mobile/app-links";

export const dynamic = "force-dynamic";

export function GET() {
  const body = appleAppSiteAssociation();
  if (!body) return new NextResponse(null, { status: 404 });
  return NextResponse.json(body, { headers: { "Cache-Control": "public, max-age=3600" } });
}
