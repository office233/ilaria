import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { checkDb } from "@/lib/health";

export const dynamic = "force-dynamic";

async function GET_impl() {
  const result = await checkDb();
  return NextResponse.json(result, { status: result.status === "ok" ? 200 : 503 });
}

export const GET = withErrorHandling(GET_impl);
