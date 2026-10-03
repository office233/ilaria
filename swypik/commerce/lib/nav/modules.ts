/**
 * Registrul UNIC al modulelor Swypik — sursa pentru meniul aplicației
 * (AppMenu), BottomNav, EcosystemBar și grila din Discover.
 *
 * Adaugi un modul nou? O singură intrare aici + cheia `appMenu.items.<id>`
 în messages/*.json (7 limbi). Modulele cu flag OFF
 * sunt ASCUNSE (niciodată afișate gri).
 *
 * Eliminate intenționat (decizia owner-ului): Squad Buy, App Store/Developers.
 * Cares (donații) e ascuns până există un ONG partener — nu are intrare aici;
 * readaugă-l în grupul `community` cu `flag: "cares"` când e cazul.
 */
import {
  Bell,
  Bike,
  BedDouble,
  Bookmark,
  Car,
  Clapperboard,
  Compass,
  Gamepad2,
  HelpCircle,
  Home,
  KeyRound,
  LayoutGrid,
  MessageSquareText,
  Music,
  Newspaper,
  Package,
  Plane,
  Plus,
  Radio,
  Shield,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Store,
  Target,
  Truck,
  User,
  Luggage,
  Video,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";
import type { ClientFeatureName } from "@/lib/feature-flags-client";

export type NavGroup =
  | "shopping"
  | "mobility"
  | "travel"
  | "entertainment"
  | "community"
  | "business"
  | "settings";

/** Ordinea grupurilor în meniu. */
export const NAV_GROUPS: readonly NavGroup[] = [
  "shopping",
  "mobility",
  "travel",
  "entertainment",
  "community",
  "business",
  "settings",
];

export type ViewerRole = "guest" | "shopper" | "creator" | "seller" | "courier" | "fleet" | "host" | "admin";

export type NavModule = {
  id: string;
  route: string;
  icon: LucideIcon;
  group: NavGroup;
  /** Cheie i18n sub `appMenu.items`. */
  labelKey: string;
  /** Flag client; OFF → modulul dispare din toată navigarea. */
  flag?: ClientFeatureName;
  /** Vizibil doar pentru aceste roluri (admin vede tot ce are `roles`). */
  roles?: readonly ViewerRole[];
  /** Când rolul lipsește: CTA „Devino …” către această rută (altfel ascuns). */
  become?: { route: string; labelKey: string };
  /** Apare în EcosystemBar / grila Discover. */
  ecosystem?: boolean;
};

export const NAV_MODULES: readonly NavModule[] = [
  // ── Cumpărături ──
  { id: "shop", route: "/shop", icon: ShoppingBag, group: "shopping", labelKey: "shop", ecosystem: true },
  { id: "categories", route: "/categories", icon: LayoutGrid, group: "shopping", labelKey: "categories" },
  { id: "live", route: "/live", icon: Radio, group: "shopping", labelKey: "live", flag: "live", ecosystem: true },
  { id: "orders", route: "/orders", icon: Package, group: "shopping", labelKey: "orders" },
  { id: "cart", route: "/cart", icon: ShoppingCart, group: "shopping", labelKey: "cart" },
  { id: "collections", route: "/collections", icon: Bookmark, group: "shopping", labelKey: "collections" },

  // ── Mobilitate & livrare ──
  { id: "go", route: "/go", icon: Car, group: "mobility", labelKey: "go", flag: "go", ecosystem: true },
  { id: "food", route: "/food", icon: UtensilsCrossed, group: "mobility", labelKey: "food", flag: "food", ecosystem: true },

  // ── Călătorii ──
  { id: "stays", route: "/stays", icon: BedDouble, group: "travel", labelKey: "stays", flag: "stays", ecosystem: true },
  { id: "fly", route: "/fly", icon: Plane, group: "travel", labelKey: "fly", flag: "fly", ecosystem: true },

  // ── Divertisment ──
  { id: "movies", route: "/movies", icon: Clapperboard, group: "entertainment", labelKey: "movies", flag: "movies", ecosystem: true },
  { id: "music", route: "/music", icon: Music, group: "entertainment", labelKey: "music", flag: "music", ecosystem: true },
  { id: "gaming", route: "/gaming", icon: Gamepad2, group: "entertainment", labelKey: "gaming", flag: "gaming", ecosystem: true },
  { id: "news", route: "/news", icon: Newspaper, group: "entertainment", labelKey: "news", flag: "news", ecosystem: true },

  // ── Comunitate ──
  { id: "messages", route: "/inbox", icon: MessageSquareText, group: "community", labelKey: "messages", flag: "messenger" },
  { id: "notifications", route: "/notifications", icon: Bell, group: "community", labelKey: "notifications" },
  { id: "missions", route: "/missions", icon: Target, group: "community", labelKey: "missions", flag: "missions", ecosystem: true },

  // ── Business & roluri ──
  {
    id: "seller",
    route: "/seller",
    icon: Store,
    group: "business",
    labelKey: "seller",
    roles: ["seller"],
    become: { route: "/become-a-seller", labelKey: "becomeSeller" },
  },
  {
    id: "creator",
    route: "/creator",
    icon: Sparkles,
    group: "business",
    labelKey: "creator",
    roles: ["creator"],
    become: { route: "/become-a-creator", labelKey: "becomeCreator" },
  },
  // Studioul live al creatorului (fără CTA propriu: „Devino creator" e mai sus).
  { id: "liveStudio", route: "/creator/live", icon: Video, group: "business", labelKey: "liveStudio", flag: "live", roles: ["creator"] },
  {
    id: "host",
    route: "/stays/manage",
    icon: KeyRound,
    group: "business",
    labelKey: "host",
    flag: "stays",
    roles: ["host"],
    become: { route: "/join/host", labelKey: "becomeHost" },
  },
  {
    id: "courier",
    route: "/courier",
    icon: Bike,
    group: "business",
    labelKey: "courier",
    roles: ["courier"],
    become: { route: "/join", labelKey: "becomeCourier" },
  },
  {
    id: "fleet",
    route: "/fleet",
    icon: Truck,
    group: "business",
    labelKey: "fleet",
    roles: ["fleet"],
    become: { route: "/join/fleet", labelKey: "becomeFleet" },
  },
  { id: "admin", route: "/admin", icon: Shield, group: "business", labelKey: "admin", roles: ["admin"] },

  // ── Setări & ajutor (tema, limba și linkurile legale sunt randate separat de AppMenu) ──
  { id: "account", route: "/account", icon: User, group: "settings", labelKey: "account" },
  { id: "myStays", route: "/account/stays", icon: Luggage, group: "settings", labelKey: "myStays", flag: "stays" },
  { id: "help", route: "/help", icon: HelpCircle, group: "settings", labelKey: "help" },
];

export type BottomNavKey = "home" | "discover" | "create" | "inbox" | "profile";

export type BottomNavItem = {
  key: BottomNavKey;
  route: string;
  icon: LucideIcon;
  /** Butonul central proeminent („+”). */
  center?: boolean;
};

/** Home = feed-ul video · Discover · Create · Inbox · Profile. Etichete: `nav.<key>`. */
export const BOTTOM_NAV: readonly BottomNavItem[] = [
  { key: "home", route: "/", icon: Home },
  { key: "discover", route: "/discover", icon: Compass },
  { key: "create", route: "/reels/record", icon: Plus, center: true },
  { key: "inbox", route: "/inbox", icon: MessageSquareText },
  { key: "profile", route: "/account", icon: User },
];

/** Linkuri legale din subsolul meniului (etichete `appMenu.legal.<key>`). */
export const LEGAL_LINKS: readonly { key: string; route?: string; externalHref?: string }[] = [
  { key: "terms", route: "/terms" },
  { key: "privacy", route: "/privacy" },
  { key: "cookies", route: "/legal/cookies" },
  { key: "anpc", route: "/legal/anpc" },
  // Obligatorii (Reg. UE 524/2013): soluționarea alternativă/online a litigiilor.
  { key: "sal", externalHref: "https://anpc.ro/ce-este-sal/" },
  { key: "sol", externalHref: "https://ec.europa.eu/consumers/odr" },
];
