/** Orașe pentru căutarea de cazări — nume RO + coordonate (fără geocoding extern). */
export type StayCity = { slug: string; name: string; country: string; lat: number; lng: number; aliases?: string[] };

export const STAY_CITIES: StayCity[] = [
    // România
    { slug: "bucuresti", name: "București", country: "România", lat: 44.4268, lng: 26.1025, aliases: ["bucharest"] },
    { slug: "cluj", name: "Cluj-Napoca", country: "România", lat: 46.7712, lng: 23.6236 },
    { slug: "brasov", name: "Brașov", country: "România", lat: 45.6579, lng: 25.6012 },
    { slug: "timisoara", name: "Timișoara", country: "România", lat: 45.7489, lng: 21.2087 },
    { slug: "iasi", name: "Iași", country: "România", lat: 47.1585, lng: 27.6014 },
    { slug: "sibiu", name: "Sibiu", country: "România", lat: 45.7983, lng: 24.1256 },
    { slug: "constanta", name: "Constanța", country: "România", lat: 44.1598, lng: 28.6348 },
    { slug: "mamaia", name: "Mamaia", country: "România", lat: 44.2519, lng: 28.6182 },
    { slug: "sinaia", name: "Sinaia", country: "România", lat: 45.35, lng: 25.55 },
    { slug: "poiana-brasov", name: "Poiana Brașov", country: "România", lat: 45.5952, lng: 25.5555 },
    // Europa
    { slug: "viena", name: "Viena", country: "Austria", lat: 48.2082, lng: 16.3738, aliases: ["vienna", "wien"] },
    { slug: "roma", name: "Roma", country: "Italia", lat: 41.9028, lng: 12.4964, aliases: ["rome"] },
    { slug: "milano", name: "Milano", country: "Italia", lat: 45.4642, lng: 9.19, aliases: ["milan"] },
    { slug: "venetia", name: "Veneția", country: "Italia", lat: 45.4408, lng: 12.3155, aliases: ["venice"] },
    { slug: "paris", name: "Paris", country: "Franța", lat: 48.8566, lng: 2.3522 },
    { slug: "londra", name: "Londra", country: "UK", lat: 51.5074, lng: -0.1278, aliases: ["london"] },
    { slug: "barcelona", name: "Barcelona", country: "Spania", lat: 41.3874, lng: 2.1686 },
    { slug: "madrid", name: "Madrid", country: "Spania", lat: 40.4168, lng: -3.7038 },
    { slug: "lisabona", name: "Lisabona", country: "Portugalia", lat: 38.7223, lng: -9.1393, aliases: ["lisbon"] },
    { slug: "amsterdam", name: "Amsterdam", country: "Olanda", lat: 52.3676, lng: 4.9041 },
    { slug: "berlin", name: "Berlin", country: "Germania", lat: 52.52, lng: 13.405 },
    { slug: "munchen", name: "München", country: "Germania", lat: 48.1351, lng: 11.582, aliases: ["munich", "munchen"] },
    { slug: "praga", name: "Praga", country: "Cehia", lat: 50.0755, lng: 14.4378, aliases: ["prague"] },
    { slug: "budapesta", name: "Budapesta", country: "Ungaria", lat: 47.4979, lng: 19.0402, aliases: ["budapest"] },
    { slug: "atena", name: "Atena", country: "Grecia", lat: 37.9838, lng: 23.7275, aliases: ["athens"] },
    { slug: "salonic", name: "Salonic", country: "Grecia", lat: 40.6401, lng: 22.9444, aliases: ["thessaloniki"] },
    { slug: "santorini", name: "Santorini", country: "Grecia", lat: 36.3932, lng: 25.4615 },
    { slug: "creta", name: "Creta (Heraklion)", country: "Grecia", lat: 35.3387, lng: 25.1442, aliases: ["heraklion"] },
    { slug: "istanbul", name: "Istanbul", country: "Turcia", lat: 41.0082, lng: 28.9784 },
    { slug: "antalya", name: "Antalya", country: "Turcia", lat: 36.8969, lng: 30.7133 },
    { slug: "dubai", name: "Dubai", country: "EAU", lat: 25.2048, lng: 55.2708 },
    { slug: "zurich", name: "Zürich", country: "Elveția", lat: 47.3769, lng: 8.5417, aliases: ["zurich"] },
    { slug: "nisa", name: "Nisa", country: "Franța", lat: 43.7102, lng: 7.262, aliases: ["nice"] },
    { slug: "dubrovnik", name: "Dubrovnik", country: "Croația", lat: 42.6507, lng: 18.0944 },
    { slug: "split", name: "Split", country: "Croația", lat: 43.5081, lng: 16.4402 },
    { slug: "malta", name: "Malta (Valletta)", country: "Malta", lat: 35.8989, lng: 14.5146, aliases: ["valletta"] },
    { slug: "new-york", name: "New York", country: "SUA", lat: 40.7128, lng: -74.006, aliases: ["nyc"] },
];

function norm(s: string): string {
    return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function searchCities(query: string, limit = 8): StayCity[] {
    const q = norm(query.trim());
    if (q.length < 2) return [];
    const starts: StayCity[] = [];
    const contains: StayCity[] = [];
    for (const c of STAY_CITIES) {
        const hay = [norm(c.name), c.slug, ...(c.aliases ?? []).map(norm)];
        if (hay.some((h) => h.startsWith(q))) starts.push(c);
        else if (hay.some((h) => h.includes(q))) contains.push(c);
    }
    return [...starts, ...contains].slice(0, limit);
}

export function cityBySlug(slug: string): StayCity | undefined {
    return STAY_CITIES.find((c) => c.slug === slug);
}
