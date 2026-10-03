/**
 * POST /api/host/upload — poză pentru o cazare (multipart/form-data, `file`).
 * Doar gazde active. Tipul/semnătura/mărimea se validează în lib/storage/upload;
 * cheia e `stays/<userId>/…` — listările acceptă DOAR poze din acest spațiu.
 */
import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { uploadFile } from "@/lib/storage/upload";
import { staysError } from "@/lib/stays/errors";
import { requireHost } from "@/lib/stays/hosts";
import { limitOrThrow, requireSession, staysRoute } from "@/lib/stays/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const POST = staysRoute("host/upload", async (req: Request) => {
    const session = await requireSession();
    await limitOrThrow(req, "host-upload", session.userId, { limit: 60, window: 3600 });
    await requireHost(session.userId);

    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return staysError("invalid_input");

    try {
        const result = await uploadFile(Buffer.from(await file.arrayBuffer()), file.name || "photo.jpg", file.type, {
            keyPrefix: `stays/${session.userId}`,
        });
        logger.info({ user: session.userId, size: result.size }, "stays: host photo uploaded");
        return NextResponse.json({ ok: true, url: result.url });
    } catch (err) {
        logger.warn({ err }, "stays: host upload rejected");
        return staysError("invalid_input");
    }
});
