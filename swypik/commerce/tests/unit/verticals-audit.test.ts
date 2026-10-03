import { describe, it, expect } from "vitest";
import { searchCities, cityBySlug, STAY_CITIES } from "@/lib/stays/cities";
import { POPULAR_DESTINATIONS, destinationImage, destinationLabel } from "@/lib/fly/destinations";
import { isOpenNow, hasKnownHours } from "@/lib/merchants/hours";

describe("Swypik Stays - Cities & Geography", () => {
    it("has valid Zurich slug and aliases (regression check)", () => {
        const zurich = cityBySlug("zurich");
        expect(zurich).toBeDefined();
        expect(zurich?.name).toBe("Zürich");
        expect(zurich?.country).toBe("Elveția");
        expect(zurich?.aliases).toContain("zurich");
        // Ensure old buggy slug viena2 does NOT resolve to Zurich
        expect(cityBySlug("viena2")).toBeUndefined();
    });

    it("finds Romanian cities by prefix or diacritics", () => {
        const buc = searchCities("Bucur");
        expect(buc.some((c) => c.slug === "bucuresti")).toBe(true);

        const cluj = searchCities("cluj");
        expect(cluj.some((c) => c.slug === "cluj")).toBe(true);

        const brasov = searchCities("brasov");
        expect(brasov.some((c) => c.slug === "brasov")).toBe(true);
    });

    it("all stay cities have valid coordinates and non-empty slugs", () => {
        expect(STAY_CITIES.length).toBeGreaterThan(20);
        for (const city of STAY_CITIES) {
            expect(city.slug).toMatch(/^[a-z0-9-]+$/);
            expect(city.lat).toBeGreaterThan(-90);
            expect(city.lat).toBeLessThan(90);
            expect(city.lng).toBeGreaterThan(-180);
            expect(city.lng).toBeLessThan(180);
            expect(city.name.length).toBeGreaterThan(1);
        }
    });
});

describe("Swypik Fly - Popular Destinations", () => {
    it("contains verified IATA airport codes", () => {
        expect(POPULAR_DESTINATIONS.length).toBeGreaterThanOrEqual(10);
        for (const d of POPULAR_DESTINATIONS) {
            expect(d.iata).toMatch(/^[A-Z]{3}$/);
            expect(d.city.length).toBeGreaterThan(1);
            expect(d.country.length).toBeGreaterThan(1);
            expect(d.image).toMatch(/^https:\/\//);
        }
    });

    it("resolves destination image and label correctly", () => {
        const bcnImage = destinationImage("BCN");
        expect(bcnImage).toContain("unsplash.com");

        const bcnLabel = destinationLabel("BCN");
        expect(bcnLabel).toBe("Barcelona, Spania");

        // Fallback for unknown
        const unknownImage = destinationImage("XYZ");
        expect(unknownImage).toMatch(/^https:\/\//);
        expect(destinationLabel("XYZ")).toBeNull();
    });
});

describe("Swypik Food - Merchant Operating Hours", () => {
    it("handles is_open_override properly", () => {
        // Explicitly closed
        expect(isOpenNow({}, false)).toBe(false);
        // Explicitly open
        expect(isOpenNow({}, true)).toBe(true);
    });

    it("detects when hours are configured vs unknown", () => {
        expect(hasKnownHours(null)).toBe(false);
        expect(hasKnownHours({})).toBe(false);
        expect(hasKnownHours({ mon: { open: "09:00", close: "22:00" } })).toBe(true);
    });
});
