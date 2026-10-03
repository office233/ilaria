"use server";

import { dbQuery } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { sendSellerApprovalEmail } from "@/lib/email/service";
import { logger } from "@/lib/logger";
import { logAdminAction } from "@/lib/security/admin-audit";
import { assertAdminPermission } from "@/lib/admin/action-guard";

export async function approveSeller(id: string) {
  // Server actions are independently invokable POST endpoints — the /admin layout
  // guard does not protect them, so every action must check the admin permission itself.
  const actor = await assertAdminPermission("partners");
  try {
    const result = await dbQuery(
      "UPDATE sellers SET status = 'approved' WHERE id = $1 AND status <> 'approved' RETURNING email, name",
      [id]
    );

    if (result.rows.length > 0) {
      const { email, name } = result.rows[0];
      if (email) {
        await sendSellerApprovalEmail(email, name || "Seller");
      }
      await logAdminAction({
        action: "seller.approve",
        targetType: "seller",
        targetId: id,
        actor,
      });
    }

    revalidatePath("/admin/sellers");
  } catch (error) {
    logger.error({ err: error, sellerId: id }, "[admin/sellers] failed to approve seller");
    throw new Error("seller_approve_failed");
  }
}

const VERIFICATION_STATUSES = new Set(["unverified", "pending", "verified", "rejected"]);
const PAYOUT_STATUSES = new Set(["not_connected", "pending", "connected", "restricted"]);

/**
 * Updates the editable fields of a creator/seller profile (creator_profiles
 * table). Account activation/suspension is intentionally NOT handled here —
 * that goes through the dedicated /admin/users suspend flow, which also
 * revokes sessions; duplicating it here with a raw status write would create
 * an inconsistent, half-suspended account.
 */
export async function updateSellerProfile(profileId: string, formData: FormData) {
  const actor = await assertAdminPermission("partners");
  const displayName = String(formData.get("display_name") || "").trim().slice(0, 200) || null;
  const handle = String(formData.get("handle") || "").trim().slice(0, 60);
  const bio = String(formData.get("bio") || "").trim().slice(0, 2000) || null;
  const websiteUrl = String(formData.get("website_url") || "").trim().slice(0, 500) || null;
  const verificationStatus = String(formData.get("verification_status") || "");
  const payoutStatus = String(formData.get("payout_status") || "");

  if (!handle) {
    throw new Error("handle_required");
  }
  if (!VERIFICATION_STATUSES.has(verificationStatus)) {
    throw new Error("invalid_verification_status");
  }
  if (!PAYOUT_STATUSES.has(payoutStatus)) {
    throw new Error("invalid_payout_status");
  }

  try {
    const { rows } = await dbQuery(
      `UPDATE creator_profiles
          SET display_name = $2,
              handle = $3,
              bio = $4,
              website_url = $5,
              verification_status = $6,
              payout_status = $7,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id`,
      [profileId, displayName, handle, bio, websiteUrl, verificationStatus, payoutStatus]
    );
    if (rows.length === 0) {
      throw new Error("profile_not_found");
    }

    await logAdminAction({
      action: "seller.profile_update",
      targetType: "creator_profile",
      targetId: profileId,
      details: { verificationStatus, payoutStatus },
      actor,
    });

    revalidatePath(`/admin/sellers/${profileId}`);
  } catch (error) {
    logger.error({ err: error, profileId }, "[admin/sellers] failed to update seller profile");
    if (error instanceof Error && ["handle_required", "invalid_verification_status", "invalid_payout_status", "profile_not_found"].includes(error.message)) {
      throw error;
    }
    throw new Error("profile_update_failed");
  }
}
