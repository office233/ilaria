/**
 * Lista de așteptare Swypik Fly („anunță-mă când se lansează”).
 * Un email = un rând (index unic pe lower(email)); reînscrierea actualizează
 * destinația dorită și limba, fără să dezvăluie dacă emailul exista deja.
 */
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { LOCALES } from "@/lib/i18n/config";

export const waitlistSchema = z.object({
    email: z.string().trim().toLowerCase().email().max(254),
    destination: z.string().trim().max(80).optional(),
    origin: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{3}$/)
        .optional(),
    locale: z.enum(LOCALES).optional(),
    /** Câmp-capcană: oamenii nu-l văd; boții îl completează. */
    website: z.string().max(200).optional(),
});
export type WaitlistInput = z.infer<typeof waitlistSchema>;

export async function joinWaitlist(input: WaitlistInput, userId: string | null): Promise<void> {
    await dbQuery(
        `INSERT INTO fly_waitlist (email, user_id, origin, destination, locale)
         VALUES ($1, $2::uuid, $3, $4, $5)
         ON CONFLICT ((lower(email))) DO UPDATE
            SET destination = COALESCE(EXCLUDED.destination, fly_waitlist.destination),
                origin = COALESCE(EXCLUDED.origin, fly_waitlist.origin),
                user_id = COALESCE(fly_waitlist.user_id, EXCLUDED.user_id),
                locale = EXCLUDED.locale,
                updated_at = now()`,
        [input.email, userId, input.origin ?? null, input.destination || null, input.locale ?? "ro"],
    );
}
