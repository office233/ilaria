/**
 * Admin — cereri de retragere ale creatorilor (payout_requests, kind = 'creator').
 * „Marchează plătit” = transfer Stripe Connect când e disponibil, altfel confirmarea
 * transferului bancar manual; „Respinge” = suma revine în portofel.
 */
import { AdminForbidden } from "@/components/admin/AdminForbidden";
import { requireAdminPage } from "@/lib/admin/guard";
import { CreatorPayoutsAdmin } from "./_components/CreatorPayoutsAdmin";

export const dynamic = "force-dynamic";

export default async function AdminCreatorPayoutsPage() {
  if (!(await requireAdminPage("finance"))) return <AdminForbidden />;
  return <CreatorPayoutsAdmin />;
}
