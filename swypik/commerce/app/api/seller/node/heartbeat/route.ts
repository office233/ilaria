import { NextResponse } from "next/server";
import { z } from "zod";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { validateNodeHeartbeat } from "@/lib/node/node-protocol";
import { recordHeartbeat } from "@/lib/node/heartbeat-store";
import { parseBody } from "@/lib/validation/schemas";
import { withErrorHandling } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

const HeartbeatSchema = z.object({
  nodeId: z.string().trim().min(3).max(64),
  isOnline: z.boolean(),
  pingMs: z.coerce.number().int().min(0).max(60_000),
  pendingSyncCount: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const POST = withErrorHandling(async function POST(req: Request) {
  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const parsed = parseBody(HeartbeatSchema, await req.json().catch(() => null));
  if (!parsed.ok) {
    return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
  }

  const heartbeat = { ...parsed.data, sellerId, timestamp: new Date().toISOString() };
  const validation = validateNodeHeartbeat(heartbeat);
  if (!validation.valid) {
    return NextResponse.json(
      { success: false, error: validation.reason, nodeStatus: "disconnected_error" },
      { status: 400 },
    );
  }

  await recordHeartbeat(sellerId, {
    nodeId: heartbeat.nodeId,
    timestamp: heartbeat.timestamp,
    pingMs: heartbeat.pingMs,
    pendingSyncCount: heartbeat.pendingSyncCount,
  });

  return NextResponse.json({ success: true, nodeStatus: "online_hosting", ackTimestamp: heartbeat.timestamp });
});
