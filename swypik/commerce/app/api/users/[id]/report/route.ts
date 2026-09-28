/** POST /api/users/[id]/report { reason, details? } — doar conturi reale. */
import { handleReport } from "@/lib/social/reports";

export const dynamic = "force-dynamic";

export const POST = (req: Request, ctx: { params: Promise<{ id: string }> }) => handleReport(req, ctx, "user");
