import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { checkQueue } from "@/lib/health";

export const dynamic = "force-dynamic";

async function GET_impl() {
  const result = await checkQueue();
  return NextResponse.json(result, { status: result.status === "ok" ? 200 : 503 });
}

export const GET = withErrorHandling(GET_impl);
