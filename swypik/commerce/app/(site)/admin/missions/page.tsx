/**
 * Admin — misiuni pentru creatori: toate misiunile (selleri + platformă), escrow,
 * jurizare și misiuni noi finanțate de platformă. Limitele vin din `missionLimits()`.
 */
import { requireAdminSession } from "@/lib/security/admin-auth";
import { missionLimits } from "@/lib/missions/config";
import { MissionsAdmin } from "./_components/MissionsAdmin";

export const dynamic = "force-dynamic";

export default async function AdminMissionsPage() {
  await requireAdminSession();
  return <MissionsAdmin limits={missionLimits()} />;
}
