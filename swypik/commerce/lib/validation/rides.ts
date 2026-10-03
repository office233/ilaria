/**
 * Zod schemas — Swypik Go (curse).
 *
 * Fișier separat de `schemas.ts` intenționat: `schemas.ts` e editat de mai
 * mulți agenți în paralel; verticala Go își ține contractele aici.
 */
import { z } from "zod";

export const VEHICLE_CLASSES = ["economy", "comfort", "van"] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];

export const RIDE_STATUSES = [
  "requested",
  "searching",
  "accepted",
  "arriving",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type RideStatus = (typeof RIDE_STATUSES)[number];

const PointSchema = z.object({
  address: z.string().trim().min(3, "Adresă prea scurtă").max(300),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

export const RideEstimateSchema = z.object({
  pickup: PointSchema,
  dropoff: PointSchema,
  vehicle_class: z.enum(VEHICLE_CLASSES).default("economy"),
  // city NU mai vine de la client — e derivat server-side din pickup
  // (reverse geocoding). Îl acceptăm în body doar pentru compat, dar îl ignorăm.
  city: z.string().trim().max(120).optional(),
  country: z.string().trim().length(2).default("RO"),
});

export const RideCreateSchema = RideEstimateSchema.extend({
  // Audit 2026-09: "wallet" era acceptat aici și de CHECK-ul din DB, dar nu
  // există nicăieri o debitare a pasagerului pentru curse — nici în lib/rides,
  // nici în lib/wallet, nici în webhook-uri. Cursa se crea, pasagerul nu plătea
  // niciodată, iar la finalizare șoferul era creditat din fondurile platformei.
  // `rideCustody` blochează acum decontarea (fail-closed), dar o cursă "wallet"
  // ar rămâne pur și simplu nedecontabilă — deci nu o mai acceptăm deloc.
  // Se readaugă odată cu implementarea debitului din wallet.
  // Metodele permise efectiv vin din go_settings (policy.allowedPaymentMethods).
  payment_method: z.enum(["cash", "card"]).default("card"),
  notes: z.string().trim().max(500).optional(),
});

export const RideStatusPatchSchema = z.object({
  status: z.enum(["arriving", "in_progress", "completed", "cancelled"]),
  reason: z.string().trim().max(300).optional(),
  cancel_reason: z
    .enum(["wait_too_long", "wrong_address", "driver_not_coming", "changed_mind", "other"])
    .optional(),
});

export const RidePayActionSchema = z.object({
  action: z.enum(["authorize", "confirm", "collect_cash"]),
});

export const RideQuoteSchema = z.object({
  pickup: PointSchema,
  dropoff: PointSchema,
  country: z.string().trim().length(2).default("RO"),
});

export const RideRatingSchema = z.object({
  stars: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).optional(),
});
