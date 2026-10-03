import { NextResponse } from "next/server";
import { z } from "zod";
import { getAccountUserId, getOptionalSocialUserId } from "@/lib/social/session";
import { DM_CONFIG, DM_GROUP_MEMBERS_HARD_MAX } from "@/lib/dm/config";
import { dmDisabledResponse, dmErrorResponse, dmRateLimit, unauthorized } from "@/lib/dm/http";
import {
  addGroupMembers,
  listGroupMembers,
  removeGroupMember,
  setGroupAdmin,
} from "@/lib/dm/groups";
import { invalidIdResponse, isUuidParam } from "@/lib/validation/params";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const AddSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1).max(DM_GROUP_MEMBERS_HARD_MAX - 1),
}).strict();
const RemoveSchema = z.object({ user_id: z.string().uuid() }).strict();
const AdminSchema = z.object({ user_id: z.string().uuid(), is_admin: z.boolean() }).strict();

async function conversationId(ctx: Ctx): Promise<string | Response> {
  const { id } = await ctx.params;
  return isUuidParam(id) ? id : invalidIdResponse();
}

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const disabled = dmDisabledResponse();
  if (disabled) return disabled;
  const id = await conversationId(ctx);
  if (id instanceof Response) return id;
  try {
    const userId = await getOptionalSocialUserId();
    if (!userId) return unauthorized();
    return NextResponse.json({ members: await listGroupMembers(id, userId) });
  } catch (err) {
    return dmErrorResponse(err, "list group members");
  }
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const disabled = dmDisabledResponse();
  if (disabled) return disabled;
  const id = await conversationId(ctx);
  if (id instanceof Response) return id;
  try {
    const userId = await getAccountUserId();
    if (!userId) return unauthorized();
    const limited = await dmRateLimit(req, "dmGroupManage", userId, DM_CONFIG.rate.groupManage);
    if (limited) return limited;
    const parsed = AddSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "validation_error" }, { status: 400 });
    const added = await addGroupMembers(id, userId, parsed.data.user_ids);
    return NextResponse.json({ added });
  } catch (err) {
    return dmErrorResponse(err, "add group members");
  }
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const disabled = dmDisabledResponse();
  if (disabled) return disabled;
  const id = await conversationId(ctx);
  if (id instanceof Response) return id;
  try {
    const userId = await getAccountUserId();
    if (!userId) return unauthorized();
    const limited = await dmRateLimit(req, "dmGroupManage", userId, DM_CONFIG.rate.groupManage);
    if (limited) return limited;
    const parsed = RemoveSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "validation_error" }, { status: 400 });
    await removeGroupMember(id, userId, parsed.data.user_id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return dmErrorResponse(err, "remove group member");
  }
}

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const disabled = dmDisabledResponse();
  if (disabled) return disabled;
  const id = await conversationId(ctx);
  if (id instanceof Response) return id;
  try {
    const userId = await getAccountUserId();
    if (!userId) return unauthorized();
    const limited = await dmRateLimit(req, "dmGroupManage", userId, DM_CONFIG.rate.groupManage);
    if (limited) return limited;
    const parsed = AdminSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "validation_error" }, { status: 400 });
    await setGroupAdmin(id, userId, parsed.data.user_id, parsed.data.is_admin);
    return NextResponse.json({ success: true });
  } catch (err) {
    return dmErrorResponse(err, "set group admin");
  }
}
