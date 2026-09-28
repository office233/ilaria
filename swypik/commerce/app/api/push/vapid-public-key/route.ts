import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { frozenResponse, isEnabled } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

async function GET_impl() {
  if (!isEnabled("pushNotifications")) return frozenResponse("pushNotifications");
  const key = process.env.VAPID_PUBLIC_KEY || "";
  return NextResponse.json({ key });
}

export const GET = withErrorHandling(GET_impl);
