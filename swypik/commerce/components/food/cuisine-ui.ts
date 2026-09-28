"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  Beef, Cake, Coffee, Drumstick, Fish, Flame, Ham, Pizza, Salad, Sandwich, Soup, UtensilsCrossed, type LucideIcon,
} from "lucide-react";

/** Iconița chip-ului pentru fiecare id canonic (lib/merchants/cuisines.json). */
export const CUISINE_ICONS: Record<string, LucideIcon> = {
  pizza: Pizza,
  burgers: Ham,
  asian: Soup,
  romanian: UtensilsCrossed,
  desserts: Cake,
  healthy: Salad,
  kebab: Drumstick,
  sushi: Fish,
  italian: Beef,
  grill: Flame,
  fast_food: Sandwich,
  cafe: Coffee,
};

/** Eticheta tradusă a unei bucătării (foodHub.cuisine.<id>); id necunoscut → null. */
export function useCuisineLabel() {
  const t = useTranslations("foodHub.cuisine");
  return useCallback((id: string): string | null => (t.has(id) ? t(id) : null), [t]);
}
