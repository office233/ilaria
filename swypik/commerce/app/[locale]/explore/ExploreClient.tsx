"use client";

/**
 * Feed-ul video (Home + /explore). Implementarea e în components/explore/*
 * (player, rail de acțiuni, carduri de modul); aici rămâne doar punctul de intrare.
 */
import FeedScreen from "@/components/explore/FeedScreen";

export default function ExploreClient({ initialCategory = "" }: { initialCategory?: string }) {
  return <FeedScreen initialCategory={initialCategory} />;
}
