/**
 * Meniul consolei de admin — O SINGURĂ sursă, grupată pe module.
 * AdminShell (desktop + mobil) citește de aici; fiecare intrare are
 * permisiunea necesară (intrările fără drept sunt ascunse).
 *
 * Etichete: `adminShell.nav.section.<group>` / `adminShell.nav.item.<id>`.
 * Pagini construite de alte module (merchant-claims, missions, creator-payouts,
 * movies, go) sunt doar legate aici.
 */
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlertTriangle,
  Banknote,
  BarChart3,
  BedDouble,
  Briefcase,
  Car,
  Clock,
  Coins,
  FileText,
  Film,
  Inbox,
  LayoutDashboard,
  Music,
  Newspaper,
  ScrollText,
  Shield,
  ShieldAlert,
  ShoppingBag,
  Star,
  Store,
  Trophy,
  Truck,
  Undo2,
  UserCheck,
  Users,
  UtensilsCrossed,
  Video,
  Wallet,
} from "lucide-react";
import { hasPermission, type AdminPermission, type AdminRole } from "./permissions";

export type AdminNavItem = {
  id: string;
  href: string;
  icon: LucideIcon;
  permission: AdminPermission;
};

export type AdminNavGroup = {
  id: string;
  items: AdminNavItem[];
};

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    id: "overview",
    items: [
      { id: "dashboard", href: "/admin", icon: LayoutDashboard, permission: "dashboard" },
      { id: "audit", href: "/admin/audit", icon: ScrollText, permission: "audit" },
    ],
  },
  {
    id: "moderation",
    items: [
      { id: "moderation", href: "/admin/moderation", icon: ShieldAlert, permission: "moderation" },
      { id: "videos", href: "/admin/videos", icon: Video, permission: "content" },
      { id: "reviews", href: "/admin/reviews", icon: Star, permission: "moderation" },
    ],
  },
  {
    id: "users",
    items: [
      { id: "users", href: "/admin/users", icon: Users, permission: "users.manage" },
      { id: "partnerApplications", href: "/admin/aplicatii", icon: Inbox, permission: "partners" },
      { id: "creators", href: "/admin/creators", icon: UserCheck, permission: "content" },
      { id: "creatorApplications", href: "/admin/applications", icon: FileText, permission: "partners" },
      { id: "sellers", href: "/admin/sellers", icon: Briefcase, permission: "partners" },
    ],
  },
  {
    id: "shopping",
    items: [
      { id: "orders", href: "/admin/orders", icon: ShoppingBag, permission: "commerce" },
      { id: "marketplace", href: "/admin/marketplace", icon: Store, permission: "commerce" },
      { id: "risk", href: "/admin/risk", icon: AlertTriangle, permission: "commerce" },
      { id: "strikes", href: "/admin/strikes", icon: Shield, permission: "commerce" },
      { id: "returns", href: "/admin/returns", icon: Undo2, permission: "commerce" },
      { id: "refunds", href: "/admin/refunds", icon: Coins, permission: "finance" },
      { id: "disputes", href: "/admin/disputes", icon: Shield, permission: "finance" },
    ],
  },
  {
    id: "food",
    items: [{ id: "merchantClaims", href: "/admin/merchant-claims", icon: UtensilsCrossed, permission: "partners" }],
  },
  {
    id: "mobility",
    items: [
      { id: "go", href: "/admin/go", icon: Car, permission: "mobility" },
      { id: "fleet", href: "/admin/fleet", icon: Truck, permission: "mobility" },
      { id: "pricing", href: "/admin/pricing", icon: Coins, permission: "mobility" },
      { id: "courierPayouts", href: "/admin/courier-payouts", icon: Truck, permission: "finance" },
    ],
  },
  {
    id: "stays",
    items: [{ id: "hosts", href: "/admin/hosts", icon: BedDouble, permission: "partners" }],
  },
  {
    id: "entertainment",
    items: [
      { id: "movies", href: "/admin/movies", icon: Film, permission: "content" },
      { id: "music", href: "/admin/music", icon: Music, permission: "content" },
      { id: "news", href: "/admin/news", icon: Newspaper, permission: "content" },
      { id: "missions", href: "/admin/missions", icon: Trophy, permission: "content" },
      { id: "creatorPayouts", href: "/admin/creator-payouts", icon: Banknote, permission: "finance" },
      { id: "sellerPayouts", href: "/admin/seller-payouts", icon: Banknote, permission: "finance" },
    ],
  },
  {
    id: "finance",
    items: [
      { id: "payouts", href: "/admin/payouts", icon: Wallet, permission: "finance" },
      { id: "commissions", href: "/admin/commissions", icon: BarChart3, permission: "finance" },
    ],
  },
  {
    id: "system",
    items: [
      { id: "health", href: "/admin/health", icon: Activity, permission: "system" },
      { id: "cron", href: "/admin/cron", icon: Clock, permission: "system" },
    ],
  },
];

/** Meniul filtrat după rolul adminului; grupurile goale dispar. */
export function navForRole(role: AdminRole | "machine"): AdminNavGroup[] {
  return ADMIN_NAV.map((g) => ({ ...g, items: g.items.filter((i) => hasPermission(role, i.permission)) })).filter(
    (g) => g.items.length > 0,
  );
}

/** Cea mai specifică intrare activă pentru `pathname` (ex. /admin nu e activ pe /admin/users). */
export function activeNavHref(pathname: string, groups: AdminNavGroup[] = ADMIN_NAV): string | null {
  let best: string | null = null;
  for (const g of groups) {
    for (const i of g.items) {
      const match = i.href === "/admin" ? pathname === "/admin" : pathname === i.href || pathname.startsWith(`${i.href}/`);
      if (match && (!best || i.href.length > best.length)) best = i.href;
    }
  }
  return best;
}
