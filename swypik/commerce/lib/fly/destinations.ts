/**
 * Destinații populare din România — listă curată pentru grila de pe /fly.
 * Imagini Unsplash directe (CDN images.unsplash.com, gratuite, hotlink permis).
 * Prețurile "de la" vin din /api/fly/deals (Duffel, cache Redis 12h).
 */

export type PopularDestination = {
    iata: string;
    city: string;
    country: string;
    image: string; // URL absolut
};

const u = (id: string) =>
    `https://images.unsplash.com/${id}?auto=format&fit=crop&w=800&q=60`;

export const POPULAR_DESTINATIONS: PopularDestination[] = [
    { iata: "BCN", city: "Barcelona", country: "Spania", image: u("photo-1583422409516-2895a77efded") },
    { iata: "LHR", city: "Londra", country: "UK", image: u("photo-1513635269975-59663e0ac1ad") },
    { iata: "CDG", city: "Paris", country: "Franța", image: u("photo-1502602898657-3e91760cbb34") },
    { iata: "FCO", city: "Roma", country: "Italia", image: u("photo-1552832230-c0197dd311b5") },
    { iata: "AMS", city: "Amsterdam", country: "Olanda", image: u("photo-1534351590666-13e3e96b5017") },
    { iata: "ATH", city: "Atena", country: "Grecia", image: u("photo-1555993539-1732b0258235") },
    { iata: "IST", city: "Istanbul", country: "Turcia", image: u("photo-1524231757912-21f4fe3a7200") },
    { iata: "DXB", city: "Dubai", country: "EAU", image: u("photo-1512453979798-5ea266f8880c") },
    { iata: "VIE", city: "Viena", country: "Austria", image: u("photo-1516550893923-42d28e5677af") },
    { iata: "MAD", city: "Madrid", country: "Spania", image: u("photo-1539037116277-4db20889f2d4") },
    { iata: "JFK", city: "New York", country: "SUA", image: u("photo-1496442226666-8d4d0e62e6e9") },
    { iata: "LIS", city: "Lisabona", country: "Portugalia", image: u("photo-1585208798174-6cedd86e019a") },
];

/** Poza destinației după IATA (fallback generic avion). */
export function destinationImage(iata: string): string {
    return (
        POPULAR_DESTINATIONS.find((d) => d.iata === iata)?.image ??
        u("photo-1436491865332-7a61a109cc05")
    );
}

export function destinationLabel(iata: string): string | null {
    const d = POPULAR_DESTINATIONS.find((x) => x.iata === iata);
    return d ? `${d.city}, ${d.country}` : null;
}
