"use client";

import useSWR from "swr";
import { rolesFromViewer } from "./visibility";
import type { ViewerRole } from "./modules";

export type Viewer = {
  userId: string;
  role: string | null;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  sellerId: string | null;
};

async function fetchJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

const SWR_OPTS = { revalidateOnFocus: false, dedupingInterval: 60_000, shouldRetryOnError: false } as const;

/** Profilul există și nu a fost respins → are acces la propriul portal (acolo vede statusul). */
function hasActiveProfile(status: string | null | undefined, exists: boolean): boolean {
  return exists && status !== "rejected";
}

/**
 * Utilizatorul curent + rolurile pentru navigare. `enabled=false` amână
 * request-urile (ex. meniul le face doar când e deschis).
 */
export function useViewer(enabled = true): {
  viewer: Viewer | null;
  roles: Set<ViewerRole>;
  loading: boolean;
} {
  const me = useSWR(enabled ? "/api/auth/me" : null, (u: string) => fetchJson<{ user: Viewer | null }>(u), SWR_OPTS);
  const viewer = me.data?.user ?? null;
  const loggedIn = Boolean(viewer);
  const courier = useSWR(
    enabled && loggedIn ? "/api/couriers" : null,
    (u: string) => fetchJson<{ courier?: { verification_status?: string | null } | null }>(u),
    SWR_OPTS,
  );
  const fleet = useSWR(
    enabled && loggedIn ? "/api/fleet-partners" : null,
    (u: string) => fetchJson<{ partner?: { status?: string | null } | null }>(u),
    SWR_OPTS,
  );
  // Gazdă Stays activă (aplicație aprobată, nesuspendată) → „Panou gazdă" în loc de „Devino gazdă".
  const host = useSWR(
    enabled && loggedIn ? "/api/host/listings" : null,
    (u: string) => fetchJson<{ approved?: boolean }>(u),
    SWR_OPTS,
  );
  const courierProfile = courier.data?.courier ?? null;
  const fleetPartner = fleet.data?.partner ?? null;
  const roles = rolesFromViewer(viewer, {
    courierApproved: hasActiveProfile(courierProfile?.verification_status, Boolean(courierProfile)),
    fleetApproved: hasActiveProfile(fleetPartner?.status, Boolean(fleetPartner)),
    hostApproved: host.data?.approved === true,
  });
  return { viewer, roles, loading: enabled && me.isLoading };
}
