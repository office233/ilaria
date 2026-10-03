/**
 * Admin: upload a file to Stripe as dispute evidence and return the file_id.
 * POST /api/admin/disputes/:disputeId/upload  multipart/form-data
 *   field "file": the binary file (max 5MB)
 *
 * Returns { success, file_id } — caller then includes file_id in the evidence
 * field (e.g. receipt, shipping_documentation, customer_signature) via the
 * existing POST /api/admin/disputes endpoint.
 *
 * Client-facing `error` values are stable codes (never Romanian sentences) —
 * the admin UI (DisputeEvidenceForm) translates them for display.
 */
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin/guard";
import { getStripe } from "@/lib/stripe/checkout";
import { dbQuery } from "@/lib/db";
import { logAdminAction } from "@/lib/security/admin-audit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
]);
// Stripe file purpose is fixed server-side — never taken from client input.
const STRIPE_UPLOAD_PURPOSE = "dispute_evidence" as const;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ disputeId: string }> },
) {
  const actor = await requireAdmin(req, "finance");
  if (actor instanceof NextResponse) return actor;
  const { disputeId } = await params;
  if (!/^dp_[A-Za-z0-9]{1,97}$/.test(disputeId)) {
    return NextResponse.json({ error: "invalid_dispute_id" }, { status: 400 });
  }

  const { rows } = await dbQuery<{ id: string }>(
    `SELECT id::text FROM stripe_disputes WHERE dispute_id = $1 LIMIT 1`,
    [disputeId],
  );
  if (rows.length === 0) {
    return NextResponse.json({ error: "dispute_not_found" }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form_data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: "missing_file_field" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "file_too_large", maxBytes: MAX_BYTES }, { status: 413 });
  }
  const mime = file.type || "application/octet-stream";
  if (!ALLOWED_MIMES.has(mime)) {
    return NextResponse.json({ error: "unsupported_mime_type" }, { status: 415 });
  }
  const filename = file instanceof File && file.name ? file.name : `dispute-evidence.${mime.split("/")[1] || "bin"}`;

  try {
    const stripe = getStripe();
    const buf = Buffer.from(await file.arrayBuffer());
    const uploaded = await stripe.files.create({
      purpose: STRIPE_UPLOAD_PURPOSE,
      file: {
        data: buf,
        name: filename,
        type: mime,
      },
    });

    await logAdminAction({
      action: "dispute.upload_evidence_file",
      targetType: "stripe_dispute",
      targetId: disputeId,
      details: { fileId: uploaded.id, mime, size: file.size },
      req,
      actor,
    });

    logger.info(
      { disputeId, fileId: uploaded.id, size: file.size, mime, filename },
      "[Admin] Dispute file uploaded to Stripe",
    );

    return NextResponse.json({ success: true, file_id: uploaded.id, filename, size: file.size, mime });
  } catch (err: unknown) {
    logger.error({ err, disputeId }, "[Admin] Stripe files.create failed");
    return NextResponse.json({ error: "stripe_error" }, { status: 502 });
  }
}
