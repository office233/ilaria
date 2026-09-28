/**
 * Swypik Go — setările operaționale (tabela `go_settings`, un rând).
 * Editate din /admin/go (auditate). Dacă tabela lipsește (migrarea
 * 20260926_0071 neaplicată) se folosesc valorile implicite de mai jos,
 * suprascriibile din env — niciodată constante ascunse în rute/UI.
 */
import { z } from "zod";
import { dbQuery } from "@/lib/db";
import { logger } from "@/lib/logger";

export { DRIVER_DOCUMENT_TYPES, type DriverDocumentType, type GoSettings } from "./settings-shared";
import { DRIVER_DOCUMENT_TYPES, type GoSettings } from "./settings-shared";

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

export function defaultGoSettings(): GoSettings {
  return {
    card_enabled: process.env.GO_CARD_ENABLED !== "0",
    cash_enabled: process.env.GO_CASH_ENABLED === "1",
    free_cancel_grace_seconds: envInt("GO_FREE_CANCEL_GRACE_SECONDS", 120),
    fare_overrun_cap_bps: envInt("GO_FARE_OVERRUN_CAP_BPS", 2000),
    payment_auth_ttl_minutes: envInt("GO_PAYMENT_AUTH_TTL_MINUTES", 15),
    required_driver_documents: ["id_card", "driving_license", "arr_attestation", "rca_insurance", "vehicle_registration"],
  };
}

export const GoSettingsPatchSchema = z
  .object({
    card_enabled: z.boolean(),
    cash_enabled: z.boolean(),
    free_cancel_grace_seconds: z.number().int().min(0).max(3600),
    fare_overrun_cap_bps: z.number().int().min(0).max(10_000),
    payment_auth_ttl_minutes: z.number().int().min(2).max(120),
    required_driver_documents: z.array(z.enum(DRIVER_DOCUMENT_TYPES)).max(DRIVER_DOCUMENT_TYPES.length),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty_patch" });
export type GoSettingsPatch = z.infer<typeof GoSettingsPatchSchema>;

const COLUMNS =
  "card_enabled, cash_enabled, free_cancel_grace_seconds, fare_overrun_cap_bps, payment_auth_ttl_minutes, required_driver_documents";

export async function getGoSettings(): Promise<GoSettings> {
  try {
    const { rows } = await dbQuery<GoSettings>(`SELECT ${COLUMNS} FROM go_settings WHERE id = 1`);
    return rows[0] ?? defaultGoSettings();
  } catch (err) {
    logger.warn({ err }, "[go-settings] tabela lipsește — folosim valorile implicite");
    return defaultGoSettings();
  }
}

/** Actualizează setările (cheile vin dintr-un schema zod → nume de coloane sigure). */
export async function updateGoSettings(patch: GoSettingsPatch): Promise<GoSettings> {
  const keys = Object.keys(patch) as (keyof GoSettingsPatch)[];
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  await dbQuery(`INSERT INTO go_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  const { rows } = await dbQuery<GoSettings>(
    `UPDATE go_settings SET ${sets}, updated_at = now() WHERE id = 1 RETURNING ${COLUMNS}`,
    keys.map((k) => patch[k]),
  );
  return rows[0] ?? { ...defaultGoSettings(), ...patch };
}
