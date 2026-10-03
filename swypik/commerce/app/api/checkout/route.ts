/**
 * POST /api/checkout — RETRAS (2026-09-28).
 *
 * Era checkout-ul vechi pentru vizitatori (Stripe Checkout Session): fără cont,
 * fără verificarea de fraudă, fără rezervare de stoc, cu `automatic_tax` (cere
 * Stripe Tax) și `locale: "ro"` fix; webhook-ul lui scădea stocul într-o coloană
 * inexistentă. Checkout-ul magazinului e acum `POST /api/checkout/create-intent`
 * (comandă din coșul din DB, cont obligatoriu, rezervare de stoc, PaymentIntent).
 *
 * Răspundem 410 cu un cod stabil ca orice client vechi (inclusiv proxy-ul
 * `/api/v1/checkout`) să primească o eroare clară în loc de o plată fără comandă.
 * Nimic din platform-api (Go) nu apela această rută.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const LEGACY_CHECKOUT_GONE = {
  success: false,
  code: "legacy_checkout_retired",
  error: "legacy_checkout_retired",
  replacement: "/api/checkout/create-intent",
} as const;

function gone() {
  return NextResponse.json(LEGACY_CHECKOUT_GONE, { status: 410, headers: { "Cache-Control": "no-store" } });
}

export async function POST() {
  return gone();
}

export async function GET() {
  return gone();
}
