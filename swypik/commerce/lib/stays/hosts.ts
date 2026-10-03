/**
 * Gazde Stays — modelul unic `stay_hosts` (migrarea 20260926_0051).
 * O gazdă devine activă la aprobarea aplicației (/admin/hosts); gazdele
 * aprobate înainte de 0051 sunt create leneș la primul acces.
 */
import { dbQuery } from "@/lib/db";
import { StaysError } from "./errors";

export type HostProfile = {
    userId: string;
    propertyType: string | null;
    city: string | null;
    county: string | null;
    maxGuests: number | null;
};

/** Creează/reactivează gazda la aprobarea aplicației. Idempotent. */
export async function ensureHostFromApplication(userId: string, applicationId: string): Promise<void> {
    await dbQuery(
        `INSERT INTO stay_hosts (user_id, source, host_application_id)
         VALUES ($1::uuid, 'application', $2::uuid)
         ON CONFLICT (user_id) DO UPDATE
            SET host_application_id = COALESCE(stay_hosts.host_application_id, EXCLUDED.host_application_id),
                updated_at = now()`,
        [userId, applicationId],
    );
}

/** Profilul gazdei active (cu valorile implicite din aplicație), sau null. */
export async function getActiveHost(userId: string): Promise<HostProfile | null> {
    const { rows } = await dbQuery<{
        user_id: string | null;
        status: string | null;
        app_id: string | null;
        property_type: string | null;
        city: string | null;
        county: string | null;
        max_guests: number | null;
    }>(
        `SELECT h.user_id::text, h.status, a.id::text AS app_id, a.property_type, a.city, a.county, a.max_guests
           FROM (SELECT $1::uuid AS uid) x
           LEFT JOIN stay_hosts h ON h.user_id = x.uid
           LEFT JOIN LATERAL (
                SELECT id, property_type, city, county, max_guests FROM host_applications
                 WHERE user_id = x.uid AND status = 'approved'
                 ORDER BY reviewed_at DESC NULLS LAST LIMIT 1
           ) a ON true`,
        [userId],
    );
    const r = rows[0];
    if (!r) return null;
    if (r.status === "suspended") return null;
    if (!r.user_id) {
        if (!r.app_id) return null;
        await ensureHostFromApplication(userId, r.app_id);
    }
    return { userId, propertyType: r.property_type, city: r.city, county: r.county, maxGuests: r.max_guests };
}

export async function requireHost(userId: string): Promise<HostProfile> {
    const host = await getActiveHost(userId);
    if (!host) throw new StaysError("not_host");
    return host;
}
