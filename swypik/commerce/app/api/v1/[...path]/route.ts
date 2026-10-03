import { withErrorHandling } from "@/lib/api-handler";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

async function fallback(req: Request, socialPath: string) {
  if (req.method === "GET" && socialPath === "/v1/notifications") {
    return NextResponse.json({
      notifications: [],
      unread: 0,
      source: "next-fallback",
    });
  }

  return NextResponse.json(
    {
      ok: false,
      error: "Go social API is not configured for this endpoint.",
      endpoint: socialPath,
    },
    { status: 503 }
  );
}

function notExposed() {
  return NextResponse.json(
    { ok: false, error: "Not found" },
    { status: 404, headers: { "Cache-Control": "private, no-store" } },
  );
}

async function handle(req: Request, context: RouteContext) {
  const { path } = await context.params;
  const socialPath = `/v1/${path.join("/")}`;

  // Catch-all-ul este intenționat fail-closed. Rutele v1 publice/active au
  // handlers Next dedicați (`/feed`, `/events`, `/events/batch`, `/creator/*`).
  // Nu proxăm căi arbitrare către platform-api deoarece proxy-ul server-side
  // atașează credentialul intern; identitatea rutelor Go legacy vine din body,
  // deci un proxy generic ar transforma orice client într-un apelant trusted.
  if (socialPath === "/v1/admin" || socialPath.startsWith("/v1/admin/")) {
    return notExposed();
  }
  // Checkout-ul vechi (Stripe Checkout Session pentru vizitatori) e retras: nici
  // ruta Next /api/checkout, nici /v1/checkout din platform-api (cu URL-uri de
  // test swypik.local) nu mai primesc plăți prin acest proxy. Codul stabil îi
  // trimite pe clienții vechi la /api/checkout/create-intent.
  if (socialPath === "/v1/checkout" || socialPath.startsWith("/v1/checkout/")) {
    return NextResponse.json(
      {
        success: false,
        code: "legacy_checkout_retired",
        error: "legacy_checkout_retired",
        replacement: "/api/checkout/create-intent",
      },
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Compatibilitate temporară: nu există date de notificări în acest fallback
  // și, important, nu încercăm niciodată upstream-ul Go pentru această cale.
  if (req.method === "GET" && socialPath === "/v1/notifications") {
    return fallback(req, socialPath);
  }

  return notExposed();
}

async function GET_impl(req: Request, context: RouteContext) {
  return handle(req, context);
}

async function POST_impl(req: Request, context: RouteContext) {
  return handle(req, context);
}

async function PUT_impl(req: Request, context: RouteContext) {
  return handle(req, context);
}

async function PATCH_impl(req: Request, context: RouteContext) {
  return handle(req, context);
}

async function DELETE_impl(req: Request, context: RouteContext) {
  return handle(req, context);
}

export const GET = withErrorHandling(GET_impl);
export const POST = withErrorHandling(POST_impl);
export const PUT = withErrorHandling(PUT_impl);
export const PATCH = withErrorHandling(PATCH_impl);
export const DELETE = withErrorHandling(DELETE_impl);
