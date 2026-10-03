/** Contractele API Swypik Go folosite de UI (rider, șofer). */

export type Place = { address: string; lat: number; lng: number };

export type QuoteClass = {
  vehicle_class: string;
  max_passengers: number | null;
  total_cents: number;
  currency: string;
  distance_km: number;
  duration_min: number;
  surge_multiplier: number;
};

export type Quote = {
  city: string;
  classes: QuoteClass[];
  payment_methods: ("card" | "cash")[];
  free_cancel_grace_seconds: number;
  fare_overrun_cap_bps: number;
};

export type RideDetail = {
  id: string;
  status: string;
  vehicle_class: string;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_address: string;
  dropoff_lat: number;
  dropoff_lng: number;
  estimated_fare_cents: number | null;
  final_fare_cents: number | null;
  currency: string;
  distance_km: string | null;
  duration_min: number | null;
  surge_multiplier: string;
  payment_method: string;
  payment_status: string;
  authorized_amount_cents: number | null;
  cancel_fee_cents: number | null;
  cancel_fee_status: string;
  cancelled_by: string | null;
  cancel_reason: string | null;
  requested_at: string;
  accepted_at: string | null;
  share_token: string | null;
};

export type RideDriver = {
  full_name: string;
  vehicle_type: string;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  vehicle_plate: string | null;
  rating: string | null;
  phone?: string;
  current_lat: number | null;
  current_lng: number | null;
};

export type CancelPolicy = { fee_cents_now: number; zone_fee_cents: number; free_until: string | null };

export type RideResponse = {
  ride: RideDetail;
  driver: RideDriver | null;
  ratings: { rater_role: string; stars: number }[];
  role: "rider" | "driver" | "admin";
  cancel_policy: CancelPolicy;
};

export const ACTIVE_RIDE_STATUSES = ["accepted", "arriving", "in_progress"] as const;
export const SEARCHING_RIDE_STATUSES = ["requested", "searching"] as const;
