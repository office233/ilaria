/**
 * GET /api/couriers/me — profilul de șofer/curier al userului logat:
 * statusul de onboarding (verificare, activ), documentele cu statusul lor și
 * lista documentelor obligatorii (șoferi: go_settings; curieri: FOOD_COURIER_REQUIRED_DOCUMENTS). `courier: null` = nu a aplicat.
 */
import { NextResponse } from "next/server";
import { getAuthSession } from "@/lib/auth/session";
import { getCourierForUser, getDriverDocuments } from "@/lib/rides/driver-job";
import { requiredDocumentsFor } from "@/lib/fleet/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getAuthSession();
  if (!session?.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const courier = await getCourierForUser(session.userId);
  if (!courier) return NextResponse.json({ courier: null, documents: [], required_documents: [] });

  const [documents, required] = await Promise.all([getDriverDocuments(courier.id), requiredDocumentsFor(courier.kind)]);
  return NextResponse.json({
    courier: {
      id: courier.id,
      kind: courier.kind,
      full_name: courier.full_name,
      city: courier.city,
      verification_status: courier.verification_status,
      active: courier.active,
      is_online: courier.is_online,
      rating: courier.rating,
      vehicle_plate: courier.vehicle_plate,
    },
    documents,
    required_documents: required,
  });
}
