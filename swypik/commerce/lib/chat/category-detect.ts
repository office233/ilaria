/**
 * Category Detection for Romanian shopping queries
 * Maps Romanian/English terms to catalog category names
 */

// ─── Category mapping for Romanian queries ────────────────────────
const CATEGORY_MAP: Record<string, string> = {
  // ─── Women's Clothing (81,936) ───
  "femei": "Women's Clothing", "femeie": "Women's Clothing", "dama": "Women's Clothing",
  "dame": "Women's Clothing", "women": "Women's Clothing", "woman": "Women's Clothing",
  "rochie": "Women's Clothing", "rochii": "Women's Clothing", "fusta": "Women's Clothing",
  "bluza": "Women's Clothing", "bluze": "Women's Clothing",
  // ─── Men's Clothing (4,643) ───
  "barbati": "Men's Clothing", "barbat": "Men's Clothing", "masculin": "Men's Clothing",
  "men": "Men's Clothing", "man": "Men's Clothing",
  // ─── Home, Garden & Furniture (5,285) ───
  "casa": "Home, Garden & Furniture", "acasa": "Home, Garden & Furniture",
  "mobilier": "Home, Garden & Furniture", "mobila": "Home, Garden & Furniture",
  "bucatarie": "Home, Garden & Furniture", "gradina": "Home, Garden & Furniture",
  "home": "Home, Garden & Furniture", "garden": "Home, Garden & Furniture",
  "decoratiuni": "Home, Garden & Furniture", "decor": "Home, Garden & Furniture",
  "depozitare": "Home, Garden & Furniture", "perna": "Home, Garden & Furniture",
  "perdea": "Home, Garden & Furniture", "perdele": "Home, Garden & Furniture",
  "prosoape": "Home, Garden & Furniture", "lenjerie": "Home, Garden & Furniture",
  "cana": "Home, Garden & Furniture", "pahare": "Home, Garden & Furniture",
  "vaza": "Home, Garden & Furniture", "covor": "Home, Garden & Furniture",
  "organizator": "Home, Garden & Furniture",
  // ─── Jewelry & Watches (3,634) ───
  "bijuterii": "Jewelry & Watches", "bijuterie": "Jewelry & Watches",
  "ceas": "Jewelry & Watches", "ceasuri": "Jewelry & Watches",
  "jewelry": "Jewelry & Watches", "colier": "Jewelry & Watches",
  "bratara": "Jewelry & Watches", "cercei": "Jewelry & Watches",
  "inel": "Jewelry & Watches", "inele": "Jewelry & Watches",
  "pandantiv": "Jewelry & Watches", "lantisor": "Jewelry & Watches",
  "brosa": "Jewelry & Watches", "watch": "Jewelry & Watches",
  "nunta": "Jewelry & Watches", "logodna": "Jewelry & Watches",
  // ─── Bags & Shoes (2,033) ───
  "genti": "Bags & Shoes", "geanta": "Bags & Shoes",
  "pantofi": "Bags & Shoes", "incaltaminte": "Bags & Shoes",
  "shoes": "Bags & Shoes", "bags": "Bags & Shoes",
  "ghiozdan": "Bags & Shoes", "rucsac": "Bags & Shoes",
  "portofel": "Bags & Shoes", "sandale": "Bags & Shoes",
  "adidasi": "Bags & Shoes", "cizme": "Bags & Shoes",
  "botine": "Bags & Shoes", "papuci": "Bags & Shoes",
  "sneakers": "Bags & Shoes",
  // ─── Pet Supplies (1,882) ───
  "animal": "Pet Supplies", "animale": "Pet Supplies",
  "pisica": "Pet Supplies", "pisici": "Pet Supplies",
  "caine": "Pet Supplies", "caini": "Pet Supplies",
  "pet": "Pet Supplies", "pets": "Pet Supplies",
  "lesa": "Pet Supplies", "zgarda": "Pet Supplies",
  "acvariu": "Pet Supplies", "hamster": "Pet Supplies",
  // ─── Health, Beauty & Hair (1,724) ───
  "beauty": "Health, Beauty & Hair", "frumusete": "Health, Beauty & Hair",
  "skincare": "Health, Beauty & Hair", "makeup": "Health, Beauty & Hair",
  "cosmetice": "Health, Beauty & Hair", "machiaj": "Health, Beauty & Hair",
  "crema": "Health, Beauty & Hair", "serum": "Health, Beauty & Hair",
  "sampon": "Health, Beauty & Hair", "balsam": "Health, Beauty & Hair",
  "peruca": "Health, Beauty & Hair", "peruci": "Health, Beauty & Hair",
  "unghii": "Health, Beauty & Hair", "manichiura": "Health, Beauty & Hair",
  "epilator": "Health, Beauty & Hair", "parfum": "Health, Beauty & Hair",
  "gene": "Health, Beauty & Hair",
  // ─── Toys, Kids & Babies (1,667) ───
  "copii": "Toys, Kids & Babies", "copil": "Toys, Kids & Babies",
  "bebe": "Toys, Kids & Babies", "bebelus": "Toys, Kids & Babies",
  "kids": "Toys, Kids & Babies", "jucarie": "Toys, Kids & Babies",
  "jucarii": "Toys, Kids & Babies", "toys": "Toys, Kids & Babies",
  "fetite": "Toys, Kids & Babies", "baieti": "Toys, Kids & Babies",
  "baby": "Toys, Kids & Babies", "carucior": "Toys, Kids & Babies",
  "biberon": "Toys, Kids & Babies",
  // ─── Sports & Outdoors (1,419) ───
  "sport": "Sports & Outdoors", "fitness": "Sports & Outdoors",
  "outdoor": "Sports & Outdoors", "sala": "Sports & Outdoors",
  "yoga": "Sports & Outdoors", "ciclism": "Sports & Outdoors",
  "bicicleta": "Sports & Outdoors", "pescuit": "Sports & Outdoors",
  "inot": "Sports & Outdoors", "camping": "Sports & Outdoors",
  "alergare": "Sports & Outdoors", "running": "Sports & Outdoors",
  "gym": "Sports & Outdoors", "fotbal": "Sports & Outdoors",
  // ─── Automobiles & Motorcycles (1,040) ───
  "auto": "Automobiles & Motorcycles", "masina": "Automobiles & Motorcycles",
  "moto": "Automobiles & Motorcycles", "motocicleta": "Automobiles & Motorcycles",
  "automobil": "Automobiles & Motorcycles", "car": "Automobiles & Motorcycles",
  "piese": "Automobiles & Motorcycles", "accesorii_auto": "Automobiles & Motorcycles",
  // ─── Home Improvement (951) ───
  "scule": "Home Improvement", "unelte": "Home Improvement",
  "tools": "Home Improvement", "iluminat": "Home Improvement",
  "lampa": "Home Improvement", "lampi": "Home Improvement",
  "bec": "Home Improvement", "led": "Home Improvement",
  "renovare": "Home Improvement", "bricolaj": "Home Improvement",
  // ─── Consumer Electronics (933) ───
  "electronice": "Consumer Electronics", "electronic": "Consumer Electronics",
  "gadget": "Consumer Electronics", "gadgeturi": "Consumer Electronics",
  "camera": "Consumer Electronics", "boxa": "Consumer Electronics",
  "boxe": "Consumer Electronics", "drone": "Consumer Electronics",
  "smart": "Consumer Electronics", "bluetooth": "Consumer Electronics",
  "casti": "Consumer Electronics", "headphones": "Consumer Electronics",
  // ─── Phones & Accessories (890) ───
  "telefon": "Phones & Accessories", "telefoane": "Phones & Accessories",
  "husa": "Phones & Accessories", "husă": "Phones & Accessories",
  "huse": "Phones & Accessories", "folie": "Phones & Accessories",
  "incarcator": "Phones & Accessories", "cablu": "Phones & Accessories",
  "phone": "Phones & Accessories", "iphone": "Phones & Accessories",
  "samsung": "Phones & Accessories",
  // ─── Computer & Office (274) ───
  "laptop": "Computer & Office", "computer": "Computer & Office",
  "tastatura": "Computer & Office", "mouse": "Computer & Office",
  "birou": "Computer & Office", "imprimanta": "Computer & Office",
  "usb": "Computer & Office", "ssd": "Computer & Office",
  "monitor": "Computer & Office",
  "gaming": "Computer & Office", "setup": "Computer & Office",
  "pc": "Computer & Office", "calculator": "Computer & Office",
  "consola": "Consumer Electronics", "controller": "Consumer Electronics",
};

/** Shopping words that indicate a product search intent */
export const SHOPPING_WORDS = [
  "haine", "rochie", "rochii", "pantofi", "ceas", "geanta", "bijuterii",
  "cadou", "vreau", "caut", "arat", "recomand", "aveti", "pret",
  "setup", "gaming", "monitor", "tastatura", "mouse", "laptop",
  "kit", "apartament", "copii", "jucarii", "animale", "caine", "pisica",
  "sport", "fitness", "auto", "cosmetice", "telefon", "husa", "birou",
  "scule", "electronice",
];

export function detectCategory(query: string): string | undefined {
  const normalized = query.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const words = normalized.split(/\s+/);

  // Check single words
  for (const word of words) {
    if (CATEGORY_MAP[word]) return CATEGORY_MAP[word];
  }

  // Multi-word patterns
  if (normalized.includes("haine barbat") || normalized.includes("haine de barbat") || normalized.includes("pentru barbati") || normalized.includes("pentru el")) return "Men's Clothing";
  if (normalized.includes("haine femei") || normalized.includes("haine de dama") || normalized.includes("pentru femei") || normalized.includes("pentru ea")) return "Women's Clothing";
  if (normalized.includes("haine copii") || normalized.includes("haine de copii") || normalized.includes("pentru copii")) return "Toys, Kids & Babies";
  if (normalized.includes("accesorii auto") || normalized.includes("piese auto")) return "Automobiles & Motorcycles";
  if (normalized.includes("accesorii telefon") || normalized.includes("husa telefon")) return "Phones & Accessories";
  if (normalized.includes("produse casa") || normalized.includes("pentru casa") || normalized.includes("de casa")) return "Home, Garden & Furniture";
  if (normalized.includes("ingrijire par") || normalized.includes("ingrijire piele")) return "Health, Beauty & Hair";

  return undefined;
}

export function looksLikeShopping(message: string): boolean {
  const lower = message.toLowerCase();
  return SHOPPING_WORDS.some((w) => lower.includes(w));
}
