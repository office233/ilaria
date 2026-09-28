/**
 * Navigația panoului de seller — O SINGURĂ listă, citită de sidebar-ul desktop
 * și de meniul mobil (components/dashboard/MobileDashboardNav).
 * Etichetele: `sellerPanel.nav.<id>`; iconițele: chei din components/dashboard/dashboard-icons.
 * Intrările cu flag OFF sunt ascunse (niciodată afișate gri).
 */
import type { FeatureName } from "@/lib/feature-flags";

export type SellerNavSection = "store" | "channel" | "config";

export type SellerNavItem = {
  id: string;
  href: string;
  icon: string;
  section: SellerNavSection;
  flag?: FeatureName;
};

export const SELLER_NAV_SECTIONS: readonly SellerNavSection[] = ["store", "channel", "config"];

export const SELLER_NAV: readonly SellerNavItem[] = [
  { id: "dashboard", href: "/seller", icon: "barChart3", section: "store" },
  { id: "products", href: "/seller/products", icon: "package", section: "store" },
  { id: "pos", href: "/seller/pos", icon: "store", section: "store" },
  { id: "invoices", href: "/seller/invoices", icon: "fileText", section: "store" },
  { id: "clients", href: "/seller/clients", icon: "users", section: "store" },
  { id: "orders", href: "/seller/orders", icon: "shoppingBag", section: "channel" },
  { id: "restaurant", href: "/seller/merchant", icon: "utensilsCrossed", section: "channel" },
  { id: "ads", href: "/seller/ads", icon: "megaphone", section: "channel" },
  { id: "missions", href: "/seller/missions", icon: "trophy", section: "channel" },
  { id: "payouts", href: "/seller/payouts", icon: "coins", section: "channel" },
  { id: "returns", href: "/seller/returns", icon: "undo2", section: "channel", flag: "returns" },
  { id: "settings", href: "/seller/settings", icon: "settings", section: "config" },
];

/** Intrările vizibile pentru flag-urile curente. */
export function visibleSellerNav(isEnabled: (flag: FeatureName) => boolean): SellerNavItem[] {
  return SELLER_NAV.filter((item) => !item.flag || isEnabled(item.flag));
}

