/**
 * Aeroporturi pentru autocomplete — denumiri românești + aliasuri fără
 * diacritice. Lista locală acoperă România + destinațiile frecvente; pentru
 * orice altceva căderea e pe Duffel Places API (nume englezești).
 */
export type Airport = {
    iata: string;
    city: string; // denumire RO
    name: string; // numele aeroportului
    country: string;
    aliases?: string[]; // forme alternative de căutare (fără diacritice etc.)
};

export const AIRPORTS: Airport[] = [
    // România
    { iata: "OTP", city: "București", name: "Henri Coandă (Otopeni)", country: "România", aliases: ["bucuresti", "bucharest", "otopeni"] },
    { iata: "BBU", city: "București", name: "Băneasa", country: "România", aliases: ["bucuresti", "baneasa"] },
    { iata: "CLJ", city: "Cluj-Napoca", name: "Avram Iancu", country: "România", aliases: ["cluj"] },
    { iata: "TSR", city: "Timișoara", name: "Traian Vuia", country: "România", aliases: ["timisoara"] },
    { iata: "IAS", city: "Iași", name: "Iași Intl.", country: "România", aliases: ["iasi"] },
    { iata: "SBZ", city: "Sibiu", name: "Sibiu Intl.", country: "România", aliases: [] },
    { iata: "CND", city: "Constanța", name: "Mihail Kogălniceanu", country: "România", aliases: ["constanta"] },
    { iata: "CRA", city: "Craiova", name: "Craiova Intl.", country: "România", aliases: [] },
    { iata: "BCM", city: "Bacău", name: "George Enescu", country: "România", aliases: ["bacau"] },
    { iata: "OMR", city: "Oradea", name: "Oradea Intl.", country: "România", aliases: [] },
    { iata: "SUJ", city: "Satu Mare", name: "Satu Mare Intl.", country: "România", aliases: [] },
    { iata: "TGM", city: "Târgu Mureș", name: "Transilvania", country: "România", aliases: ["targu mures", "tirgu mures"] },
    // Europa — frecvente
    { iata: "VIE", city: "Viena", name: "Vienna Intl.", country: "Austria", aliases: ["vienna", "wien"] },
    { iata: "LHR", city: "Londra", name: "Heathrow", country: "UK", aliases: ["london", "londra"] },
    { iata: "LGW", city: "Londra", name: "Gatwick", country: "UK", aliases: ["london", "londra"] },
    { iata: "LTN", city: "Londra", name: "Luton", country: "UK", aliases: ["london", "londra"] },
    { iata: "STN", city: "Londra", name: "Stansted", country: "UK", aliases: ["london", "londra"] },
    { iata: "CDG", city: "Paris", name: "Charles de Gaulle", country: "Franța", aliases: [] },
    { iata: "ORY", city: "Paris", name: "Orly", country: "Franța", aliases: [] },
    { iata: "BVA", city: "Paris", name: "Beauvais", country: "Franța", aliases: [] },
    { iata: "FCO", city: "Roma", name: "Fiumicino", country: "Italia", aliases: ["rome", "roma"] },
    { iata: "CIA", city: "Roma", name: "Ciampino", country: "Italia", aliases: ["rome", "roma"] },
    { iata: "MXP", city: "Milano", name: "Malpensa", country: "Italia", aliases: ["milan"] },
    { iata: "BGY", city: "Milano", name: "Bergamo", country: "Italia", aliases: ["milan", "bergamo"] },
    { iata: "LIN", city: "Milano", name: "Linate", country: "Italia", aliases: ["milan"] },
    { iata: "VCE", city: "Veneția", name: "Marco Polo", country: "Italia", aliases: ["venetia", "venice"] },
    { iata: "NAP", city: "Napoli", name: "Capodichino", country: "Italia", aliases: ["naples"] },
    { iata: "BLQ", city: "Bologna", name: "Guglielmo Marconi", country: "Italia", aliases: [] },
    { iata: "AMS", city: "Amsterdam", name: "Schiphol", country: "Olanda", aliases: [] },
    { iata: "BCN", city: "Barcelona", name: "El Prat", country: "Spania", aliases: [] },
    { iata: "MAD", city: "Madrid", name: "Barajas", country: "Spania", aliases: [] },
    { iata: "AGP", city: "Málaga", name: "Costa del Sol", country: "Spania", aliases: ["malaga"] },
    { iata: "PMI", city: "Palma de Mallorca", name: "Son Sant Joan", country: "Spania", aliases: ["mallorca", "palma"] },
    { iata: "VLC", city: "Valencia", name: "Valencia", country: "Spania", aliases: [] },
    { iata: "LIS", city: "Lisabona", name: "Humberto Delgado", country: "Portugalia", aliases: ["lisbon", "lisboa"] },
    { iata: "OPO", city: "Porto", name: "Francisco Sá Carneiro", country: "Portugalia", aliases: [] },
    { iata: "ATH", city: "Atena", name: "Eleftherios Venizelos", country: "Grecia", aliases: ["athens", "atena"] },
    { iata: "SKG", city: "Salonic", name: "Makedonia", country: "Grecia", aliases: ["thessaloniki", "salonic"] },
    { iata: "HER", city: "Heraklion", name: "Nikos Kazantzakis (Creta)", country: "Grecia", aliases: ["creta", "crete"] },
    { iata: "RHO", city: "Rodos", name: "Diagoras", country: "Grecia", aliases: ["rhodes", "rodos"] },
    { iata: "CFU", city: "Corfu", name: "Ioannis Kapodistrias", country: "Grecia", aliases: ["kerkyra"] },
    { iata: "ZTH", city: "Zakynthos", name: "Dionysios Solomos", country: "Grecia", aliases: ["zante"] },
    { iata: "IST", city: "Istanbul", name: "Istanbul Airport", country: "Turcia", aliases: [] },
    { iata: "SAW", city: "Istanbul", name: "Sabiha Gökçen", country: "Turcia", aliases: [] },
    { iata: "AYT", city: "Antalya", name: "Antalya", country: "Turcia", aliases: [] },
    { iata: "BER", city: "Berlin", name: "Brandenburg", country: "Germania", aliases: [] },
    { iata: "MUC", city: "München", name: "Franz Josef Strauss", country: "Germania", aliases: ["munchen", "munich"] },
    { iata: "FRA", city: "Frankfurt", name: "Frankfurt am Main", country: "Germania", aliases: [] },
    { iata: "HHN", city: "Frankfurt", name: "Hahn", country: "Germania", aliases: [] },
    { iata: "CGN", city: "Köln", name: "Köln/Bonn", country: "Germania", aliases: ["koln", "cologne"] },
    { iata: "DUS", city: "Düsseldorf", name: "Düsseldorf", country: "Germania", aliases: ["dusseldorf"] },
    { iata: "STR", city: "Stuttgart", name: "Stuttgart", country: "Germania", aliases: [] },
    { iata: "NUE", city: "Nürnberg", name: "Albrecht Dürer", country: "Germania", aliases: ["nurnberg", "nuremberg"] },
    { iata: "HAM", city: "Hamburg", name: "Hamburg", country: "Germania", aliases: [] },
    { iata: "BRU", city: "Bruxelles", name: "Zaventem", country: "Belgia", aliases: ["brussels", "bruxelles"] },
    { iata: "CRL", city: "Bruxelles", name: "Charleroi", country: "Belgia", aliases: ["brussels", "charleroi"] },
    { iata: "ZRH", city: "Zürich", name: "Zürich", country: "Elveția", aliases: ["zurich"] },
    { iata: "GVA", city: "Geneva", name: "Genève", country: "Elveția", aliases: ["geneve"] },
    { iata: "BSL", city: "Basel", name: "EuroAirport", country: "Elveția", aliases: [] },
    { iata: "CPH", city: "Copenhaga", name: "Kastrup", country: "Danemarca", aliases: ["copenhagen"] },
    { iata: "ARN", city: "Stockholm", name: "Arlanda", country: "Suedia", aliases: [] },
    { iata: "OSL", city: "Oslo", name: "Gardermoen", country: "Norvegia", aliases: [] },
    { iata: "HEL", city: "Helsinki", name: "Vantaa", country: "Finlanda", aliases: [] },
    { iata: "DUB", city: "Dublin", name: "Dublin", country: "Irlanda", aliases: [] },
    { iata: "EDI", city: "Edinburgh", name: "Edinburgh", country: "UK", aliases: [] },
    { iata: "MAN", city: "Manchester", name: "Manchester", country: "UK", aliases: [] },
    { iata: "BHX", city: "Birmingham", name: "Birmingham", country: "UK", aliases: [] },
    { iata: "PRG", city: "Praga", name: "Václav Havel", country: "Cehia", aliases: ["prague", "praga"] },
    { iata: "BUD", city: "Budapesta", name: "Ferenc Liszt", country: "Ungaria", aliases: ["budapest", "budapesta"] },
    { iata: "WAW", city: "Varșovia", name: "Chopin", country: "Polonia", aliases: ["warsaw", "varsovia"] },
    { iata: "KRK", city: "Cracovia", name: "Ioan Paul II", country: "Polonia", aliases: ["krakow", "cracovia"] },
    { iata: "SOF", city: "Sofia", name: "Sofia", country: "Bulgaria", aliases: [] },
    { iata: "BEG", city: "Belgrad", name: "Nikola Tesla", country: "Serbia", aliases: ["belgrade", "belgrad"] },
    { iata: "ZAG", city: "Zagreb", name: "Franjo Tuđman", country: "Croația", aliases: [] },
    { iata: "SPU", city: "Split", name: "Split", country: "Croația", aliases: [] },
    { iata: "DBV", city: "Dubrovnik", name: "Dubrovnik", country: "Croația", aliases: [] },
    { iata: "TIA", city: "Tirana", name: "Nënë Tereza", country: "Albania", aliases: [] },
    { iata: "SKP", city: "Skopje", name: "Skopje Intl.", country: "Macedonia de Nord", aliases: [] },
    { iata: "KIV", city: "Chișinău", name: "Chișinău Intl.", country: "Moldova", aliases: ["chisinau", "kishinev"] },
    { iata: "LCA", city: "Larnaca", name: "Larnaca (Cipru)", country: "Cipru", aliases: ["cipru", "cyprus"] },
    { iata: "PFO", city: "Paphos", name: "Paphos (Cipru)", country: "Cipru", aliases: ["cipru"] },
    { iata: "MLA", city: "Malta", name: "Malta Intl.", country: "Malta", aliases: [] },
    { iata: "NCE", city: "Nisa", name: "Côte d'Azur", country: "Franța", aliases: ["nice", "nisa"] },
    { iata: "LYS", city: "Lyon", name: "Saint-Exupéry", country: "Franța", aliases: [] },
    { iata: "MRS", city: "Marsilia", name: "Provence", country: "Franța", aliases: ["marseille", "marsilia"] },
    // Long-haul populare
    { iata: "DXB", city: "Dubai", name: "Dubai Intl.", country: "EAU", aliases: [] },
    { iata: "AUH", city: "Abu Dhabi", name: "Zayed Intl.", country: "EAU", aliases: [] },
    { iata: "DOH", city: "Doha", name: "Hamad Intl.", country: "Qatar", aliases: [] },
    { iata: "JFK", city: "New York", name: "John F. Kennedy", country: "SUA", aliases: ["nyc"] },
    { iata: "EWR", city: "New York", name: "Newark", country: "SUA", aliases: ["nyc"] },
    { iata: "TLV", city: "Tel Aviv", name: "Ben Gurion", country: "Israel", aliases: [] },
    { iata: "CAI", city: "Cairo", name: "Cairo Intl.", country: "Egipt", aliases: [] },
    { iata: "HRG", city: "Hurghada", name: "Hurghada Intl.", country: "Egipt", aliases: [] },
    { iata: "SSH", city: "Sharm El Sheikh", name: "Sharm El Sheikh Intl.", country: "Egipt", aliases: ["sharm"] },
    { iata: "RAK", city: "Marrakech", name: "Menara", country: "Maroc", aliases: ["marrakesh"] },
    { iata: "BKK", city: "Bangkok", name: "Suvarnabhumi", country: "Thailanda", aliases: [] },
];

function norm(s: string): string {
    return s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

/** Căutare locală: prefix pe oraș/alias/IATA, apoi substring. Max `limit`. */
export function searchAirports(query: string, limit = 8): Airport[] {
    const q = norm(query.trim());
    if (q.length < 2) return [];
    const starts: Airport[] = [];
    const contains: Airport[] = [];
    for (const a of AIRPORTS) {
        const hay = [a.iata.toLowerCase(), norm(a.city), norm(a.name), ...(a.aliases ?? []).map(norm)];
        if (hay.some((h) => h.startsWith(q))) starts.push(a);
        else if (hay.some((h) => h.includes(q))) contains.push(a);
        if (starts.length >= limit) break;
    }
    return [...starts, ...contains].slice(0, limit);
}
