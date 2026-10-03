import { withErrorHandling } from "@/lib/api-handler";
/**
 * GENERATED-CONSUMER-NOTE
 * Versioned public API (v1) consumed by external clients. Proxies to the Go
 * social-api when SOCIAL_API_BASE_URL is set; falls back to local feed.
 * No in-app fetch caller — only mobile / external consumers.
 */
import { NextResponse } from "next/server";
import { getCreatorSnapshotForRequest } from "@/lib/social/creator-server";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

async function GET_impl(req: Request, context: RouteContext) {
  const snapshot = await getCreatorSnapshotForRequest(req, (await context.params).id);
  return NextResponse.json(
    {
      ...snapshot,
      view: "profile",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}

export const GET = withErrorHandling(GET_impl);
