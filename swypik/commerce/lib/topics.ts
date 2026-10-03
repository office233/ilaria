export const TOPICS = [
  { id: 'funny', label: 'Funny 😂', icon: '😂' },
  { id: 'gadgets', label: 'Gadgeturi 📱', icon: '📱' },
  { id: 'ai', label: 'AI Tools 🤖', icon: '🤖' },
  { id: 'beauty', label: 'Beauty 💄', icon: '💄' },
  { id: 'fitness', label: 'Fitness 💪', icon: '💪' },
  { id: 'deals', label: 'Oferte 🏷️', icon: '🏷️' },
  { id: 'fashion', label: 'Fashion 👗', icon: '👗' },
  { id: 'food', label: 'Food 🍕', icon: '🍕' },
  { id: 'gaming', label: 'Gaming 🎮', icon: '🎮' },
  { id: 'home', label: 'Home Hacks 🏠', icon: '🏠' },
  { id: 'education', label: 'Educație 📚', icon: '📚' },
  { id: 'local', label: 'Local 📍', icon: '📍' },
  { id: 'business', label: 'Business 💼', icon: '💼' },
  { id: 'travel', label: 'Călătorii ✈️', icon: '✈️' },
] as const;

/**
 * 2026-08-14 (audit cold start): boost-ul pe interese căuta topicul EXACT în
 * `videos.tags`, dar tag-urile reale sunt `travel`, `fly`, `AMS`, `tech`… →
 * ZERO match, deci selecția de la onboarding nu influența nimic.
 *
 * Aici mapăm fiecare topic la termenii care apar efectiv în `videos.tags` și
 * în `marketplace_products.taxonomy_node_slug`. Se extinde fără migrare.
 */
export const TOPIC_SYNONYMS: Record<string, string[]> = {
  funny: ['funny', 'comedy', 'meme', 'lol', 'umor'],
  gadgets: ['gadgets', 'gadget', 'tech', 'electronics', 'electronice', 'phone', 'smartphone'],
  ai: ['ai', 'tech', 'software', 'saas', 'automation'],
  beauty: ['beauty', 'skincare', 'makeup', 'cosmetics', 'cosmetice', 'ingrijire'],
  fitness: ['fitness', 'gym', 'sport', 'workout', 'health', 'sanatate'],
  deals: ['deals', 'sale', 'discount', 'oferta', 'reduceri', 'promo'],
  fashion: ['fashion', 'clothing', 'imbracaminte', 'style', 'outfit', 'shoes'],
  food: ['food', 'mancare', 'restaurant', 'recipe', 'reteta', 'cooking', 'drinks'],
  gaming: ['gaming', 'game', 'games', 'esports', 'console', 'pc'],
  home: ['home', 'casa', 'decor', 'furniture', 'mobila', 'diy', 'garden'],
  education: ['education', 'educatie', 'learning', 'tutorial', 'howto', 'books'],
  local: ['local', 'romania', 'bucuresti', 'cluj', 'timisoara', 'iasi'],
  business: ['business', 'startup', 'entrepreneur', 'antreprenor', 'marketing', 'finance'],
  travel: ['travel', 'fly', 'flights', 'calatorii', 'zbor', 'stays', 'hotel', 'vacation'],
};

/** Termenii de căutat pentru un topic (include topicul însuși). */
export function topicSearchTerms(topicId: string): string[] {
  const syn = TOPIC_SYNONYMS[topicId] || [];
  return Array.from(new Set([topicId, ...syn]));
}
