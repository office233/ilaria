/**
 * Like pe comentariu — idempotent (PUT/DELETE), POST {liked} sau comutare
 * pentru clienții vechi. Logica: lib/social/like-route.ts; contorul: trigger DB.
 */
import { handleLikeGet, handleLikeMutation } from "@/lib/social/like-route";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = (_req: Request, ctx: Ctx) => handleLikeGet(ctx, "comment");
export const POST = (req: Request, ctx: Ctx) => handleLikeMutation(req, ctx, "comment", "body");
export const PUT = (req: Request, ctx: Ctx) => handleLikeMutation(req, ctx, "comment", "like");
export const DELETE = (req: Request, ctx: Ctx) => handleLikeMutation(req, ctx, "comment", "unlike");
