/**
 * FRONT R5 — Stripe Connect Express pentru curieri/șoferi.
 *
 * GET  /api/couriers/connect — statusul contului Connect al curierului logat.
 * POST /api/couriers/connect — creează contul (dacă lipsește) + link de
 *   onboarding → { url }. Refolosește infrastructura de la selleri
 *   (lib/stripe/connect.ts, users.stripe_connect_*); copia pe couriers
 *   (stripe_account_id, stripe_payouts_enabled) e ținută sincron pentru
 *   procesarea payout-urilor.
 */
import { NextResponse } from "next/server";
import { dbQuery } from "@/lib/db";
import { getAuthSession } from "@/lib/auth/session";
import { getAuthUser } from "@/lib/auth/getAuthUser";
import {
  getOrCreateConnectAccount,
  createOnboardingLink,
  syncConnectAccount,
} from "@/lib/stripe/connect";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = logger.child({ route: "couriers/connect" });

async function loadCourier(userId: string) {
  const { rows } = await dbQuery<{
    id: string;
    stripe_account_id: string | null;
    stripe_payouts_enabled: boolean;
  }>(
    `SELECT id, stripe_account_id, stripe_payouts_enabled
       FROM couriers WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function GET() {
  const session = await getAuthSession();
  if (!session?.userId) {
    return NextResponse.json({ error: "Autentificare necesară." }, { status: 401 });
  }
  const courier = await loadCourier(session.userId);
  if (!courier) {
    return NextResponse.json({ error: "Nu ești curier." }, { status: 403 });
  }

  if (!courier.stripe_account_id) {
    return NextResponse.json({ connected: false, payouts_enabled: false });
  }

  try {
    const status = await syncConnectAccount(courier.stripe_account_id);
    await dbQuery(
      `UPDATE couriers SET stripe_payouts_enabled = $2, updated_at = now() WHERE id = $1`,
      [courier.id, status.payoutsEnabled],
    );
    return NextResponse.json({
      connected: true,
      payouts_enabled: status.payoutsEnabled,
      details_submitted: status.detailsSubmitted,
      requirements_due: status.requirementsCurrentlyDue,
    });
  } catch (err) {
    log.error({ err, courierId: courier.id }, "connect status failed");
    return NextResponse.json({ connected: true, payouts_enabled: courier.stripe_payouts_enabled });
  }
}

export async function POST() {
  const session = await getAuthSession();
  if (!session?.userId) {
    return NextResponse.json({ error: "Autentificare necesară." }, { status: 401 });
  }
  const courier = await loadCourier(session.userId);
  if (!courier) {
    return NextResponse.json({ error: "Nu ești curier." }, { status: 403 });
  }

  try {
    const user = await getAuthUser();
    const accountId =
      courier.stripe_account_id ??
      (await getOrCreateConnectAccount(session.userId, user?.email ?? null));

    if (!courier.stripe_account_id) {
      await dbQuery(
        `UPDATE couriers SET stripe_account_id = $2, updated_at = now() WHERE id = $1`,
        [courier.id, accountId],
      );
    }

    const url = await createOnboardingLink(accountId);
    return NextResponse.json({ url });
  } catch (err) {
    log.error({ err, courierId: courier.id }, "connect onboarding failed");
    return NextResponse.json({ error: "Onboarding Stripe indisponibil momentan." }, { status: 502 });
  }
}
