/**
 * Iconițele navigației din panourile de rol (seller, creator) — cheie text →
 * componentă lucide. Config-urile de nav (server) transmit doar cheia.
 */
import {
  Banknote,
  BarChart3,
  CircleDot,
  Clapperboard,
  Coins,
  FileText,
  Flame,
  Home,
  Megaphone,
  Music,
  Package,
  Plug,
  Receipt,
  Settings,
  ShoppingBag,
  Store,
  TrendingUp,
  Trophy,
  Undo2,
  Upload,
  Users,
  UtensilsCrossed,
  Menu,
  type LucideIcon,
} from "lucide-react";

export const DASHBOARD_ICONS: Record<string, LucideIcon> = {
  barChart3: BarChart3,
  package: Package,
  shoppingBag: ShoppingBag,
  utensilsCrossed: UtensilsCrossed,
  home: Home,
  coins: Coins,
  undo2: Undo2,
  settings: Settings,
  upload: Upload,
  clapperboard: Clapperboard,
  fileText: FileText,
  trendingUp: TrendingUp,
  banknote: Banknote,
  circleDot: CircleDot,
  receipt: Receipt,
  store: Store,
  users: Users,
  megaphone: Megaphone,
  flame: Flame,
  music: Music,
  trophy: Trophy,
  plug: Plug,
};

export function dashboardIcon(key: string): LucideIcon {
  return DASHBOARD_ICONS[key] ?? Menu;
}
