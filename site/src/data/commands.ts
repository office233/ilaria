import { modules } from "./modules";

// Commands understood by the Ilaria bar. This is a scripted site navigator,
// deliberately NOT presented as the Ilaria model.
export interface Command { label: string; hint: string; href: string; icon: string; keys: string[] }

const moduleAliases: Record<string, string[]> = {
  "video-commerce": ["swypik", "feed", "video", "discover", "descopera", "reels"],
  shop: ["shop", "magazin", "cart", "cos", "marketplace", "products", "produse"],
  live: ["live", "stream", "live shopping"],
  listings: ["listings", "anunturi", "imobiliare", "auto", "real estate", "cars"],
  go: ["go", "ride", "rides", "taxi", "cursa", "masina", "uber"],
  food: ["food", "mancare", "delivery", "livrare", "restaurant"],
  stays: ["stays", "cazare", "hotel", "airbnb", "booking"],
  fly: ["fly", "zbor", "flights", "avion", "bilete"],
  movies: ["movies", "filme", "seriale", "series", "cinema"],
  music: ["music", "muzica", "songs", "artists"],
  news: ["news", "stiri", "noutati", "presa"],
  arcade: ["arcade", "gaming", "games", "jocuri", "trivia"],
  messenger: ["messenger", "mesaje", "chat", "dm", "inbox", "calls", "apeluri"],
  community: ["community", "comunitate", "social", "profile", "posts"],
  cares: ["cares", "donatii", "donate", "charity", "cauze"],
  kids: ["kids", "copii", "children"],
  missions: ["missions", "misiuni", "briefs", "brands"],
  "creator-studio": ["studio", "creator", "creators", "creatori"],
  "seller-portal": ["seller", "vanzator", "pos", "ads", "shopify"],
  wallet: ["wallet", "portofel", "bani", "money"],
  "ai-assistant": ["assistant", "asistent", "ai chat"],
  account: ["account", "cont", "login", "security", "2fa"],
};

export const commands: Command[] = [
  { label: "Home", hint: "The Swypik universe", href: "/", icon: "home", keys: ["home", "acasa", "start", "desktop"] },
  { label: "Swypik super-app", hint: "Every module", href: "/swypik/", icon: "grid", keys: ["apps", "modules", "module", "super app", "superapp", "all apps", "aplicatii"] },
  { label: "Ilaria", hint: "Our own AI · Myriad", href: "/ilaria/", icon: "spark", keys: ["ilaria", "ai", "model", "myriad", "imc", "brain"] },
  { label: "SwypikOS", hint: "Operating system & kernel", href: "/os/", icon: "cpu", keys: ["os", "swypikos", "swypik os", "kernel", "desktop shell", "sistem"] },
  { label: "Swyp", hint: "Verified programming language", href: "/swyp/", icon: "code", keys: ["swyp", "language", "limbaj", "compiler", "code"] },
  { label: "Nexus", hint: "How it all connects", href: "/nexus/", icon: "network", keys: ["nexus", "architecture", "arhitectura", "how", "connect", "ecosystem", "ecosistem"] },
  { label: "Investors", hint: "Thesis, model, roadmap", href: "/investors/", icon: "chart", keys: ["investors", "investitori", "invest", "deck", "pitch", "funding", "roadmap"] },
  { label: "Early access", hint: "Join the launch list", href: "/#early-access", icon: "star", keys: ["early access", "waitlist", "join", "signup", "inscriere"] },
  { label: "Contact", hint: "Get in touch", href: "/contact/", icon: "chat", keys: ["contact", "email", "press"] },
  ...modules.map((m) => ({
    label: m.name,
    hint: m.short,
    href: `/swypik/${m.slug}/`,
    icon: m.icon,
    keys: [m.name.toLowerCase(), m.slug, ...(moduleAliases[m.slug] ?? [])],
  })),
];
