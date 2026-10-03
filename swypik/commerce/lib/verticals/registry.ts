/**
 * Universal Marketplace — Vertical Registry
 *
 * Definește câmpurile specifice fiecărei verticale (imobiliare, auto, servicii).
 * Folosit de: wizard-ul de publicare, validarea API, filtrele de căutare,
 * afișarea pe pagina de anunț.
 *
 * Un "listing" (anunț) nu are checkout — generează inquiry-uri (lead-uri).
 */

export type FieldType = "number" | "text" | "select" | "boolean" | "year";

export interface VerticalField {
    key: string;
    type: FieldType;
    /** i18n key în messages/<locale>.json sub verticals.fields.* */
    labelKey: string;
    required?: boolean;
    /** pentru type=select */
    options?: string[];
    /** pentru type=number */
    min?: number;
    max?: number;
    unit?: string; // "m²", "km", "kW"
    /** apare ca filtru în căutare */
    filterable?: boolean;
}

export interface VerticalDefinition {
    /** prefix de taxonomy_node_slug căruia i se aplică */
    slugPrefix: string;
    listingType: "listing" | "product";
    fields: VerticalField[];
    /** prețul e opțional (ex: servicii "la cerere") */
    priceOptional?: boolean;
}

export const VERTICALS: VerticalDefinition[] = [
    {
        slugPrefix: "real-estate",
        listingType: "listing",
        fields: [
            { key: "surface_m2", type: "number", labelKey: "surface", min: 1, max: 1_000_000, unit: "m²", required: true, filterable: true },
            { key: "rooms", type: "number", labelKey: "rooms", min: 0, max: 100, filterable: true },
            { key: "bathrooms", type: "number", labelKey: "bathrooms", min: 0, max: 50, filterable: true },
            { key: "floor", type: "text", labelKey: "floor" },
            { key: "year_built", type: "year", labelKey: "yearBuilt", min: 1800, filterable: true },
            { key: "condition", type: "select", labelKey: "condition", options: ["new", "renovated", "good", "needs_renovation"], filterable: true },
            { key: "energy_class", type: "select", labelKey: "energyClass", options: ["A", "B", "C", "D", "E", "F", "G"] },
            { key: "furnished", type: "boolean", labelKey: "furnished", filterable: true },
            { key: "parking", type: "boolean", labelKey: "parking", filterable: true },
        ],
    },
    {
        slugPrefix: "vehicles/parts",
        listingType: "product", // piesele auto rămân cumpărabile normal
        fields: [
            { key: "compatible_makes", type: "text", labelKey: "compatibleMakes" },
            { key: "part_condition", type: "select", labelKey: "condition", options: ["new", "used", "refurbished"], filterable: true },
        ],
    },
    {
        slugPrefix: "vehicles",
        listingType: "listing",
        fields: [
            { key: "make", type: "text", labelKey: "make", required: true, filterable: true },
            { key: "model", type: "text", labelKey: "model", required: true, filterable: true },
            { key: "year", type: "year", labelKey: "year", min: 1900, required: true, filterable: true },
            { key: "mileage_km", type: "number", labelKey: "mileage", min: 0, max: 5_000_000, unit: "km", filterable: true },
            { key: "fuel", type: "select", labelKey: "fuel", options: ["petrol", "diesel", "hybrid", "electric", "lpg"], filterable: true },
            { key: "transmission", type: "select", labelKey: "transmission", options: ["manual", "automatic"], filterable: true },
            { key: "engine_cc", type: "number", labelKey: "engineCc", min: 0, max: 20000, unit: "cm³" },
            { key: "power_kw", type: "number", labelKey: "powerKw", min: 0, max: 2000, unit: "kW" },
            { key: "vehicle_condition", type: "select", labelKey: "condition", options: ["new", "used", "damaged"], filterable: true },
        ],
    },
    {
        slugPrefix: "services",
        listingType: "listing",
        priceOptional: true,
        fields: [
            { key: "service_area", type: "text", labelKey: "serviceArea", filterable: true },
            { key: "experience_years", type: "number", labelKey: "experienceYears", min: 0, max: 80 },
            { key: "pricing_model", type: "select", labelKey: "pricingModel", options: ["fixed", "hourly", "per_project", "on_request"], filterable: true },
            { key: "available_remote", type: "boolean", labelKey: "availableRemote", filterable: true },
        ],
    },
    {
        slugPrefix: "vacation-rentals",
        listingType: "listing",
        fields: [
            { key: "max_guests", type: "number", labelKey: "maxGuests", min: 1, max: 100, required: true, filterable: true },
            { key: "bedrooms", type: "number", labelKey: "bedrooms", min: 0, max: 50, filterable: true },
            { key: "beds", type: "number", labelKey: "beds", min: 1, max: 100 },
            { key: "bathrooms", type: "number", labelKey: "bathrooms", min: 0, max: 50, filterable: true },
            { key: "price_per_night", type: "number", labelKey: "pricePerNight", min: 0, required: true, filterable: true },
            { key: "wifi", type: "boolean", labelKey: "wifi", filterable: true },
            { key: "kitchen", type: "boolean", labelKey: "kitchen", filterable: true },
            { key: "parking", type: "boolean", labelKey: "parking", filterable: true },
            { key: "pool", type: "boolean", labelKey: "pool", filterable: true },
            { key: "pets_allowed", type: "boolean", labelKey: "petsAllowed", filterable: true },
            { key: "check_in_from", type: "text", labelKey: "checkInFrom" },
            { key: "check_out_until", type: "text", labelKey: "checkOutUntil" },
        ],
    },
];

/** Găsește definiția verticalei pentru un slug de taxonomie (cel mai specific prefix câștigă). */
export function verticalForSlug(taxonomySlug: string | null | undefined): VerticalDefinition | null {
    if (!taxonomySlug) return null;
    let best: VerticalDefinition | null = null;
    for (const v of VERTICALS) {
        if (taxonomySlug === v.slugPrefix || taxonomySlug.startsWith(v.slugPrefix + "/")) {
            if (!best || v.slugPrefix.length > best.slugPrefix.length) best = v;
        }
    }
    return best;
}

/** listing_type implicit pentru un slug de taxonomie. */
export function listingTypeForSlug(taxonomySlug: string | null | undefined): "listing" | "product" {
    return verticalForSlug(taxonomySlug)?.listingType ?? "product";
}

export interface ValidationResult {
    ok: boolean;
    errors: Record<string, string>;
    /** doar câmpurile cunoscute, curățate */
    clean: Record<string, unknown>;
}

/** Validează vertical_attributes contra definiției verticalei. */
export function validateVerticalAttributes(
    taxonomySlug: string | null | undefined,
    attrs: Record<string, unknown> | null | undefined
): ValidationResult {
    const def = verticalForSlug(taxonomySlug);
    const errors: Record<string, string> = {};
    const clean: Record<string, unknown> = {};
    if (!def) return { ok: true, errors, clean };

    const input = attrs ?? {};
    for (const f of def.fields) {
        const raw = input[f.key];
        if (raw === undefined || raw === null || raw === "") {
            if (f.required) errors[f.key] = "required";
            continue;
        }
        switch (f.type) {
            case "number":
            case "year": {
                const n = Number(raw);
                if (!Number.isFinite(n)) { errors[f.key] = "not_a_number"; break; }
                if (f.min !== undefined && n < f.min) { errors[f.key] = "too_small"; break; }
                const max = f.max ?? (f.type === "year" ? new Date().getFullYear() + 1 : undefined);
                if (max !== undefined && n > max) { errors[f.key] = "too_large"; break; }
                clean[f.key] = n;
                break;
            }
            case "boolean":
                clean[f.key] = raw === true || raw === "true" || raw === "1";
                break;
            case "select": {
                const s = String(raw);
                if (!f.options?.includes(s)) { errors[f.key] = "invalid_option"; break; }
                clean[f.key] = s;
                break;
            }
            default: {
                const s = String(raw).slice(0, 500).trim();
                if (s) clean[f.key] = s;
            }
        }
    }
    return { ok: Object.keys(errors).length === 0, errors, clean };
}
