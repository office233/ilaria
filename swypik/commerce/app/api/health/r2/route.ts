import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";
import { checkR2 } from "@/lib/health";

export const dynamic = "force-dynamic";

async function GET_impl() {
  const result = await checkR2();
  return NextResponse.json(result, { status: result.status === "ok" ? 200 : 503 });
}

export const GET = withErrorHandling(GET_impl);
