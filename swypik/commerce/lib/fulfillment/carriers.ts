/**
 * Registrul curierilor suportați la expediere — nume afișat și URL de urmărire.
 *
 * Numărul AWB vine ÎNTOTDEAUNA de la curier (introdus manual de seller sau,
 * când va exista, dintr-o integrare API). Versiunea din 16 sept 2026 „genera"
 * AWB-uri cu Math.random() pentru Sameday/FanCourier — numere inexistente,
 * trimise clienților pe email ca link de urmărire.
 */
import { APP_URL } from "@/lib/app-url";

export const CARRIER_CODES = ["sameday_easybox", "sameday", "fancourier", "standard"] as const;
export type CarrierCode = (typeof CARRIER_CODES)[number];

type CarrierDef = {
    name: string;
    trackingUrl: (awb: string) => string;
};

const CARRIERS: Record<CarrierCode, CarrierDef> = {
    sameday_easybox: {
        name: "Sameday Easybox",
        trackingUrl: (awb) => `https://sameday.ro/#awb=${encodeURIComponent(awb)}`,
    },
    sameday: {
        name: "Sameday Curier",
        trackingUrl: (awb) => `https://sameday.ro/#awb=${encodeURIComponent(awb)}`,
    },
    fancourier: {
        name: "Fan Courier",
        trackingUrl: (awb) => `https://www.fancourier.ro/awb-tracking/?awb=${encodeURIComponent(awb)}`,
    },
    standard: {
        name: "Livrare Standard",
        trackingUrl: (awb) => `${APP_URL}/tracking?awb=${encodeURIComponent(awb)}`,
    },
};

export function isCarrierCode(value: string): value is CarrierCode {
    return (CARRIER_CODES as readonly string[]).includes(value);
}

export function carrierName(code: CarrierCode): string {
    return CARRIERS[code].name;
}

export function carrierTrackingUrl(code: CarrierCode, awb: string): string {
    return CARRIERS[code].trackingUrl(awb.trim());
}
