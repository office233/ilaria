import { NextResponse } from "next/server";
import { getSellerSessionId } from "@/lib/security/seller-auth";
import { computeNodeState, generateNodeId } from "@/lib/node/node-protocol";
import { readHeartbeat } from "@/lib/node/heartbeat-store";
import { withErrorHandling } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

/**
 * Starea Nodului Local al sellerului, derivată EXCLUSIV din ultimul heartbeat
 * înregistrat (Redis, TTL). Fără heartbeat recent → deconectat. Nu se mai
 * întorc valori inventate (ping fix, „128 articole sincronizate", URL fictiv).
 */
export const GET = withErrorHandling(async function GET() {
  const sellerId = await getSellerSessionId();
  if (!sellerId) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const heartbeat = await readHeartbeat(sellerId);
  const status = computeNodeState(Boolean(heartbeat), heartbeat?.timestamp ?? null);

  return NextResponse.json({
    success: true,
    node: {
      nodeId: heartbeat?.nodeId ?? generateNodeId(sellerId),
      sellerId,
      status,
      isOnline: status === "online_hosting",
      lastHeartbeat: heartbeat?.timestamp ?? null,
      pingMs: heartbeat?.pingMs ?? null,
      pendingSync: heartbeat?.pendingSyncCount ?? null,
    },
  });
});
