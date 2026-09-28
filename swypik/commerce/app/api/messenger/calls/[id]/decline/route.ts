import { handleCallSignal } from "@/lib/messenger/call-signal-route";
import { declineCall } from "@/lib/messenger/calls";

export const dynamic = "force-dynamic";

/** POST /api/messenger/calls/[id]/decline — callee rejects a ringing call (+ închide meeting-ul RealtimeKit, oprește soneria). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleCallSignal(id, "decline", declineCall);
}
