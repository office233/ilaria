/**
 * ════════════════════════════════════════════════════════════════════════════
 *  SWYPIK — Catalogul universal de verticale
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Sursa UNICĂ de adevăr pentru tot ce se poate vinde pe Swypik.
 * Din acest fișier se generează automat:
 *   • bara de categorii din feed        • acțiunea butonului pe fiecare clip
 *   • paginile de verticală             • filtrele de căutare
 *   • formularele de publicare          • validările API
 *
 * A adăuga o verticală nouă = ~15 linii aici + traduceri. ZERO cod nou.
 *
 * Regula de aur: user-ul NU caută. Feed-ul îi propune. Verticalele sunt
 * doar felul în care organizăm intern oferta și modul de tranzacționare.
 */

/** Cum se cumpără. Determină butonul de acțiune și fluxul de checkout. */
export type TransactionMode =
    | "cart"     // coș + checkout clasic          → „Adaugă în coș”
    | "order"    // comandă live cu livrare        → „Comandă”
    | "booking"  // rezervare pe interval/slot     → „Rezervă”
    | "lead"     // cerere de ofertă / contact     → „Contactează”
    | "ride"     // cursă punct-la-punct           → „Cheamă”
    | "donation"; // campanie de strângere de fonduri → „Donează”

/** Cine are voie să publice în verticală. */
export type PublisherType =
    | "seller"       // magazin online
    | "merchant"     // business local cu program (restaurant, farmacie)
    | "agency"       // agenție (imobiliare, turism)
    | "dealer"       // dealer auto
    | "professional" // PFA / specialist (medic, coafor, meditator)
    | "host"         // gazdă cazare
    | "driver"       // șofer / curier
    | "cause";       // beneficiar verificat (ONG, familie, business la început)

export interface Vertical {
    /** identificator stabil, folosit în URL: /v/eats */
    id: string;
    /** brand internațional, apare în logo/URL */
    brand: string;
    /** cheie i18n pentru eticheta localizată (verticals.<id>.label) */
    labelKey: string;
    /** emoji folosit în bara de categorii (rapid, fără assets) */
    emoji: string;
    /** culoare de accent — se aplică PESTE tema de bază, nu o înlocuiește */
    accent: string;
    mode: TransactionMode;
    publisher: PublisherType;
    /** rădăcina în taxonomy_nodes */
    taxonomyRoot: string;
    /** are nevoie de locația utilizatorului ca să aibă sens */
    localOnly?: boolean;
    /** conținut restricționat 18+ */
    adultOnly?: boolean;
    /** valul de lansare (1 = live acum) */
    wave: 1 | 2 | 3 | 4 | 5;
    /** grupare pentru navigare */
    group: "shop" | "local" | "property" | "travel" | "services" | "mobility" | "work" | "social";
    /** subcategoriile afișate în pagina verticalei (slug relativ la taxonomyRoot) */
    subcategories?: { slug: string; labelKey: string; emoji: string }[];
}

export const VERTICAL_CATALOG: Vertical[] = [
    // ─── COMERȚ ───────────────────────────────────────────────────────────────
    {
        id: "shop", brand: "Swypik Shop", labelKey: "shop", emoji: "🛍️", accent: "#7C3AED",
        mode: "cart", publisher: "seller", taxonomyRoot: "shop", wave: 1, group: "shop",
        subcategories: [
            { slug: "fashion", labelKey: "sub.fashion", emoji: "👗" },
            { slug: "tech", labelKey: "sub.tech", emoji: "📱" },
            { slug: "beauty", labelKey: "sub.beauty", emoji: "💄" },
            { slug: "kids", labelKey: "sub.kids", emoji: "🧸" },
            { slug: "pets", labelKey: "sub.pets", emoji: "🐾" },
            { slug: "sports", labelKey: "sub.sports", emoji: "⚽" },
            { slug: "books", labelKey: "sub.books", emoji: "📚" },
            { slug: "music", labelKey: "sub.music", emoji: "🎸" },
            { slug: "art", labelKey: "sub.art", emoji: "🎨" },
            { slug: "jewelry", labelKey: "sub.jewelry", emoji: "💍" },
            { slug: "office", labelKey: "sub.office", emoji: "🖇️" },
            { slug: "collectibles", labelKey: "sub.collectibles", emoji: "🏺" },
        ],
    },
    // Medical: produse medicale (dispozitive, consumabile) — separat de Shop,
    // pentru că are reglementare proprie și cumpărători diferiți (clinici, PFA).
    {
        id: "medical", brand: "Swypik Medical", labelKey: "medical", emoji: "🩹", accent: "#0284C7",
        mode: "cart", publisher: "seller", taxonomyRoot: "medical", wave: 1, group: "shop",
        subcategories: [
            { slug: "devices", labelKey: "sub.devices", emoji: "🩻" },
            { slug: "consumables", labelKey: "sub.consumables", emoji: "🧤" },
            { slug: "mobility", labelKey: "sub.mobilityAid", emoji: "🦽" },
            { slug: "dental", labelKey: "sub.dental", emoji: "🦷" },
            { slug: "lab", labelKey: "sub.lab", emoji: "🔬" },
            { slug: "orthopedic", labelKey: "sub.orthopedic", emoji: "🦴" },
        ],
    },
    // Industrial & agricol: utilaje, echipamente, B2B.
    {
        id: "industrial", brand: "Swypik Industrial", labelKey: "industrial", emoji: "🏭", accent: "#52525B",
        mode: "cart", publisher: "seller", taxonomyRoot: "industrial", wave: 1, group: "shop",
        subcategories: [
            { slug: "machines", labelKey: "sub.machines", emoji: "⚙️" },
            { slug: "packaging", labelKey: "sub.packaging", emoji: "📦" },
            { slug: "safety", labelKey: "sub.safety", emoji: "🦺" },
            { slug: "horeca", labelKey: "sub.horeca", emoji: "🍽️" },
        ],
    },
    {
        id: "agro", brand: "Swypik Agro", labelKey: "agro", emoji: "🚜", accent: "#65A30D",
        mode: "cart", publisher: "seller", taxonomyRoot: "agro", wave: 1, group: "shop",
        subcategories: [
            { slug: "tractors", labelKey: "sub.tractors", emoji: "🚜" },
            { slug: "seeds", labelKey: "sub.seeds", emoji: "🌱" },
            { slug: "livestock", labelKey: "sub.livestock", emoji: "🐄" },
            { slug: "irrigation", labelKey: "sub.irrigation", emoji: "💧" },
        ],
    },
    {
        id: "build", brand: "Swypik Build", labelKey: "build", emoji: "🧱", accent: "#B45309",
        mode: "cart", publisher: "seller", taxonomyRoot: "build", wave: 1, group: "shop",
        subcategories: [
            { slug: "materials", labelKey: "sub.materials", emoji: "🧱" },
            { slug: "tools", labelKey: "sub.tools", emoji: "🔨" },
            { slug: "electrical", labelKey: "sub.electrical", emoji: "🔌" },
            { slug: "plumbing", labelKey: "sub.plumbing", emoji: "🚿" },
            { slug: "paint", labelKey: "sub.paint", emoji: "🎨" },
            { slug: "flooring", labelKey: "sub.flooring", emoji: "🪵" },
            { slug: "doors", labelKey: "sub.doors", emoji: "🚪" },
            { slug: "heavy", labelKey: "sub.heavy", emoji: "🏗️" },
        ],
    },
    {
        id: "home", brand: "Swypik Home", labelKey: "home", emoji: "🛋️", accent: "#A16207",
        mode: "cart", publisher: "seller", taxonomyRoot: "home", wave: 1, group: "shop",
        subcategories: [
            { slug: "furniture", labelKey: "sub.furniture", emoji: "🪑" },
            { slug: "decor", labelKey: "sub.decor", emoji: "🖼️" },
            { slug: "kitchen", labelKey: "sub.kitchen", emoji: "🍴" },
            { slug: "garden", labelKey: "sub.garden", emoji: "🌿" },
            { slug: "appliances", labelKey: "sub.appliances", emoji: "🧺" },
            { slug: "lighting", labelKey: "sub.lighting", emoji: "💡" },
        ],
    },
    {
        id: "farm", brand: "Swypik Farm", labelKey: "farm", emoji: "🥕", accent: "#4D7C0F", mode: "cart", publisher: "merchant", taxonomyRoot: "farm", wave: 1, group: "shop", localOnly: true,
        subcategories: [
            { slug: "vegetables", labelKey: "sub.vegetables", emoji: "🥬" },
            { slug: "fruits", labelKey: "sub.fruits", emoji: "🍎" },
            { slug: "dairy", labelKey: "sub.dairy", emoji: "🧀" },
            { slug: "meat", labelKey: "sub.meat", emoji: "🥩" },
            { slug: "honey", labelKey: "sub.honey", emoji: "🍯" },
            { slug: "wine", labelKey: "sub.wine", emoji: "🍷" },
        ],
    },

    // ─── LIVRARE LOCALĂ ───────────────────────────────────────────────────────
    {
        id: "eats", brand: "Swypik Food", labelKey: "eats", emoji: "🍔", accent: "#2DBE60", mode: "order", publisher: "merchant", taxonomyRoot: "food", wave: 1, group: "local", localOnly: true,
        subcategories: [
            { slug: "pizza", labelKey: "sub.pizza", emoji: "🍕" },
            { slug: "burgers", labelKey: "sub.burgers", emoji: "🍔" },
            { slug: "asian", labelKey: "sub.asian", emoji: "🍜" },
            { slug: "romanian", labelKey: "sub.romanian", emoji: "🥘" },
            { slug: "desserts", labelKey: "sub.desserts", emoji: "🍰" },
            { slug: "healthy", labelKey: "sub.healthy", emoji: "🥗" },
        ],
    },
    { id: "market", brand: "Swypik Market", labelKey: "market", emoji: "🛒", accent: "#16A34A", mode: "order", publisher: "merchant", taxonomyRoot: "grocery", wave: 1, group: "local", localOnly: true },
    { id: "pharma", brand: "Swypik Pharma", labelKey: "pharma", emoji: "💊", accent: "#0891B2", mode: "order", publisher: "merchant", taxonomyRoot: "pharmacy", wave: 1, group: "local", localOnly: true },
    { id: "flowers", brand: "Swypik Flowers", labelKey: "flowers", emoji: "💐", accent: "#EC4899", mode: "order", publisher: "merchant", taxonomyRoot: "flowers", wave: 1, group: "local", localOnly: true },
    { id: "drinks", brand: "Swypik Drinks", labelKey: "drinks", emoji: "🍷", accent: "#7E22CE", mode: "order", publisher: "merchant", taxonomyRoot: "drinks", wave: 1, group: "local", localOnly: true, adultOnly: true },

    // ─── IMOBILIARE & AUTO ────────────────────────────────────────────────────
    {
        id: "estates", brand: "Swypik Estates", labelKey: "estates", emoji: "🏠", accent: "#2563EB", mode: "lead", publisher: "agency", taxonomyRoot: "real-estate", wave: 1, group: "property",
        subcategories: [
            { slug: "apartments-sale", labelKey: "sub.apartmentsSale", emoji: "🏢" },
            { slug: "apartments-rent", labelKey: "sub.apartmentsRent", emoji: "🔑" },
            { slug: "houses-sale", labelKey: "sub.housesSale", emoji: "🏡" },
            { slug: "houses-rent", labelKey: "sub.housesRent", emoji: "🏠" },
            { slug: "land", labelKey: "sub.land", emoji: "🌍" },
            { slug: "commercial", labelKey: "sub.commercial", emoji: "🏬" },
        ],
    },
    {
        id: "auto", brand: "Swypik Auto", labelKey: "auto", emoji: "🚗", accent: "#DC2626", mode: "lead", publisher: "dealer", taxonomyRoot: "vehicles", wave: 1, group: "property",
        subcategories: [
            { slug: "cars", labelKey: "sub.cars", emoji: "🚗" },
            { slug: "motorcycles", labelKey: "sub.motorcycles", emoji: "🏍️" },
            { slug: "trucks", labelKey: "sub.trucks", emoji: "🚚" },
            { slug: "parts", labelKey: "sub.parts", emoji: "⚙️" },
        ],
    },
    { id: "rentals", brand: "Swypik Rentals", labelKey: "rentals", emoji: "🔑", accent: "#7C3AED", mode: "booking", publisher: "agency", taxonomyRoot: "rentals", wave: 1, group: "property", localOnly: true },

    // ─── TURISM & EXPERIENȚE ──────────────────────────────────────────────────
    { id: "stays", brand: "Swypik Stays", labelKey: "stays", emoji: "🏖️", accent: "#0D9488", mode: "booking", publisher: "host", taxonomyRoot: "vacation-rentals", wave: 1, group: "travel" },
    { id: "trips", brand: "Swypik Trips", labelKey: "trips", emoji: "🗺️", accent: "#38BDF8", mode: "booking", publisher: "agency", taxonomyRoot: "trips", wave: 1, group: "travel" },
    { id: "events", brand: "Swypik Events", labelKey: "events", emoji: "🎟️", accent: "#9333EA", mode: "booking", publisher: "agency", taxonomyRoot: "events", wave: 1, group: "travel" },
    { id: "fly", brand: "Swypik Fly", labelKey: "fly", emoji: "✈️", accent: "#1D4ED8", mode: "booking", publisher: "agency", taxonomyRoot: "flights", wave: 1, group: "travel" },

    // ─── SERVICII ─────────────────────────────────────────────────────────────
    { id: "beautypro", brand: "Swypik Salon", labelKey: "beautypro", emoji: "💇", accent: "#F472B6", mode: "booking", publisher: "professional", taxonomyRoot: "services/beauty", wave: 1, group: "services", localOnly: true },
    { id: "health", brand: "Swypik Health", labelKey: "health", emoji: "🩺", accent: "#0EA5E9", mode: "booking", publisher: "professional", taxonomyRoot: "services/health", wave: 1, group: "services", localOnly: true },
    { id: "fit", brand: "Swypik Fit", labelKey: "fit", emoji: "🏋️", accent: "#EA580C", mode: "booking", publisher: "professional", taxonomyRoot: "services/fitness", wave: 1, group: "services", localOnly: true },
    { id: "service", brand: "Swypik Service", labelKey: "service", emoji: "🔧", accent: "#64748B", mode: "booking", publisher: "professional", taxonomyRoot: "services/auto-service", wave: 1, group: "services", localOnly: true },
    { id: "pro", brand: "Swypik Pro", labelKey: "pro", emoji: "🛠️", accent: "#B45309", mode: "lead", publisher: "professional", taxonomyRoot: "services/home-repair", wave: 1, group: "services", localOnly: true },
    { id: "learn", brand: "Swypik Learn", labelKey: "learn", emoji: "📚", accent: "#4F46E5", mode: "lead", publisher: "professional", taxonomyRoot: "services/education", wave: 1, group: "services" },
    { id: "care", brand: "Swypik Care", labelKey: "care", emoji: "🧹", accent: "#0D9488", mode: "lead", publisher: "professional", taxonomyRoot: "services/care", wave: 1, group: "services", localOnly: true },
    { id: "biz", brand: "Swypik Biz", labelKey: "biz", emoji: "💼", accent: "#475569", mode: "lead", publisher: "professional", taxonomyRoot: "services/business", wave: 1, group: "services" },

    // ─── MOBILITATE ───────────────────────────────────────────────────────────
    { id: "go", brand: "Swypik Go", labelKey: "go", emoji: "🚕", accent: "#FACC15", mode: "ride", publisher: "driver", taxonomyRoot: "rides", wave: 1, group: "mobility", localOnly: true },
    { id: "send", brand: "Swypik Send", labelKey: "send", emoji: "📦", accent: "#F97316", mode: "order", publisher: "driver", taxonomyRoot: "courier", wave: 1, group: "mobility", localOnly: true },
    { id: "move", brand: "Swypik Move", labelKey: "move", emoji: "🚚", accent: "#78716C", mode: "lead", publisher: "professional", taxonomyRoot: "services/transport", wave: 1, group: "mobility" },

    // ─── MUNCĂ ────────────────────────────────────────────────────────────────
    { id: "jobs", brand: "Swypik Jobs", labelKey: "jobs", emoji: "💼", accent: "#1E40AF", mode: "lead", publisher: "seller", taxonomyRoot: "jobs", wave: 1, group: "work" },

    // ─── SOCIAL ───────────────────────────────────────────────────────────────
    // Donații: românii donează pentru România. Comision 0% — doar taxa de
    // procesare. Beneficiari verificați, transparență totală pe fiecare campanie.
    { id: "cares", brand: "Swypik Cares", labelKey: "cares", emoji: "🎗️", accent: "#E11D48", mode: "donation", publisher: "cause", taxonomyRoot: "donations", wave: 1, group: "social" },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BY_ID = new Map(VERTICAL_CATALOG.map((v) => [v.id, v]));

export function getVertical(id: string): Vertical | undefined {
    return BY_ID.get(id);
}

/** Verticalele lansate (wave <= currentWave), în ordinea de afișare. */
export function liveVerticals(currentWave = 1): Vertical[] {
    return VERTICAL_CATALOG.filter((v) => v.wave <= currentWave);
}

/** Verticala căreia îi aparține un slug de taxonomie (cel mai specific câștigă). */
export function verticalForTaxonomy(slug: string | null | undefined): Vertical | undefined {
    if (!slug) return undefined;
    let best: Vertical | undefined;
    for (const v of VERTICAL_CATALOG) {
        if (slug === v.taxonomyRoot || slug.startsWith(v.taxonomyRoot + "/")) {
            if (!best || v.taxonomyRoot.length > best.taxonomyRoot.length) best = v;
        }
    }
    return best;
}

/** Cheia i18n a butonului de acțiune pentru un mod de tranzacție. */
export const ACTION_KEY: Record<TransactionMode, string> = {
    cart: "actions.addToCart",
    order: "actions.order",
    booking: "actions.book",
    lead: "actions.contact",
    ride: "actions.call",
    donation: "actions.donate",
};

/** Modurile care necesită checkout cu plată online imediată. */
export const PAID_UPFRONT: TransactionMode[] = ["cart", "order", "booking"];
