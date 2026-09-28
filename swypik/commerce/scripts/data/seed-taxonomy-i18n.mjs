#!/usr/bin/env node
/**
 * scripts/seed-taxonomy-i18n.mjs
 *
 * Populates taxonomy_nodes + taxonomy_translations with the canonical
 * Swypik catalog tree, then re-classifies every active marketplace_products
 * row by setting taxonomy_node_slug based on the existing
 * taxonomy_department / taxonomy_category / taxonomy_subcategory columns.
 *
 * v2 (2026-05-18): Enriched match rules with RO labels + Wedding/Health/Kids
 *   coverage. Adds new leaf nodes for Health (massage/oral/adult) and Fashion
 *   wedding. Targets > 98% catOnly+ confidence on AE-imported corpus.
 *
 * Idempotent: ON CONFLICT upsert on both tables.
 */
import pg from "pg";

export const TREE = [
  // ── FASHION ──────────────────────────────────────────────────────────────
  {
    slug: "fashion",
    kind: "department",
    labels: { en: "Fashion", ro: "Modă" },
    aeRoots: ["200000343", "200000345", "200000297", "200574005", "320", "322", "1524", "1511"],
    children: [
      {
        slug: "fashion-women", kind: "category",
        labels: { en: "Women", ro: "Femei" },
        match: [{ dep: "fashion", cat: "women" }],
        children: [
          {
            slug: "fashion-women-clothing",
            labels: { en: "Clothing", ro: "Îmbrăcăminte" },
            match: [
              { dep: "fashion", cat: "women", sub: "clothing" },
              { dep: "fashion", cat: "women", sub: "îmbrăcăminte" },
              { dep: "fashion", cat: "women", sub: "seturi asortate" },
              { dep: "fashion", cat: "women", sub: "articole basic" },
              { dep: "fashion", cat: "women", sub: "haine plus size" },
              { dep: "fashion", cat: "women", sub: "costume de baie" },
              { dep: "fashion", cat: "women", sub: "fuste" },
              { dep: "fashion", cat: "women", sub: "faux leather" },
              { dep: "fashion", cat: "women", sub: "wool & blends" },
              { dep: "fashion", cat: "women", sub: "robes" },
              { dep: "fashion", cat: "women", sub: "ethnic wear" },
            ],
          },
          {
            slug: "fashion-women-dresses",
            labels: { en: "Dresses", ro: "Rochii" },
            match: [
              { dep: "fashion", cat: "women", sub: "dresses" },
              { dep: "fashion", cat: "women", sub: "rochii" },
              { dep: "fashion", cat: "women", sub: "rochii de mireasă" },
              { dep: "fashion", cat: "women", sub: "shirt dresses" },
              { dep: "fashion", cat: "women", sub: "nightgowns" },
              { dep: "fashion", cat: "women", sub: "vintage dresses" },
              { dep: "fashion", cat: "wedding", sub: "rochii pentru nuntă" },
              { dep: "fashion", cat: "wedding", sub: "mother of bride" },
              { dep: "fashion", cat: "wedding", sub: "rochii de bal" },
              { dep: "fashion", cat: "wedding", sub: "ținute de petrecere și vacanță" },
              { dep: "fashion", cat: "wedding" },
            ],
          },
          {
            slug: "fashion-women-tops",
            labels: { en: "Tops", ro: "Bluze și tricouri" },
            match: [
              { dep: "fashion", cat: "women", sub: "tops" },
              { dep: "fashion", cat: "women", sub: "topuri și tricouri" },
              { dep: "fashion", cat: "women", sub: "body-uri" },
              { dep: "fashion", cat: "women", sub: "crop tops" },
              { dep: "fashion", cat: "women", sub: "maiouri" },
              { dep: "fashion", cat: "women", sub: "bluze și cămăși" },
              { dep: "fashion", cat: "women", sub: "cămăși și bluze" },
              { dep: "fashion", cat: "women", sub: "plus size tops" },
            ],
          },
          {
            slug: "fashion-women-pants",
            labels: { en: "Pants", ro: "Pantaloni" },
            match: [
              { dep: "fashion", cat: "women", sub: "pants" },
              { dep: "fashion", cat: "women", sub: "pantaloni" },
            ],
          },
          {
            slug: "fashion-women-outerwear",
            labels: { en: "Outerwear", ro: "Jachete și paltoane" },
            match: [
              { dep: "fashion", cat: "women", sub: "outerwear" },
              { dep: "fashion", cat: "women", sub: "outerwear & coats" },
              { dep: "fashion", cat: "women", sub: "coats" },
              { dep: "fashion", cat: "women", sub: "paltoane și jachete" },
              { dep: "fashion", cat: "women", sub: "trench coats" },
              { dep: "fashion", cat: "women", sub: "sacouri și costume" },
            ],
          },
        ],
      },
      {
        slug: "fashion-men", kind: "category",
        labels: { en: "Men", ro: "Bărbați" },
        match: [{ dep: "fashion", cat: "men" }],
        children: [
          {
            slug: "fashion-men-clothing-basic",
            labels: { en: "Basic clothing", ro: "Îmbrăcăminte basic" },
            match: [
              { dep: "fashion", cat: "men", sub: "îmbrăcăminte basic" },
              { dep: "fashion", cat: "men", sub: "clothing" },
              { dep: "fashion", cat: "men", sub: "suits & sets" },
              { dep: "fashion", cat: "men", sub: "sets & outfits" },
              { dep: "fashion", cat: "men", sub: "îmbrăcăminte bărbați plus size" },
              { dep: "fashion", cat: "men", sub: "ethnic wear" },
              { dep: "fashion", cat: "men", sub: "dress vests" },
              { dep: "fashion", cat: "men", sub: "gothic clothing" },
              { dep: "fashion", cat: "men", sub: "vintage dresses" },
            ],
          },
          {
            slug: "fashion-men-tshirts",
            labels: { en: "T-shirts", ro: "Tricouri" },
            match: [
              { dep: "fashion", cat: "men", sub: "t-shirts" },
              { dep: "fashion", cat: "men", sub: "tricouri" },
              { dep: "fashion", cat: "men", sub: "topuri și tricouri" },
            ],
          },
          {
            slug: "fashion-men-shirts",
            labels: { en: "Shirts", ro: "Cămăși" },
            match: [
              { dep: "fashion", cat: "men", sub: "shirts" },
              { dep: "fashion", cat: "men", sub: "cămăși" },
              { dep: "fashion", cat: "men", sub: "cămăși bărbați" },
              { dep: "fashion", cat: "men", sub: "dress shirts" },
              { dep: "fashion", cat: "men", sub: "hawaiian shirts" },
            ],
          },
          {
            slug: "fashion-men-polo",
            labels: { en: "Polo shirts", ro: "Tricouri polo" },
            match: [
              { dep: "fashion", cat: "men", sub: "polo shirts" },
              { dep: "fashion", cat: "men", sub: "polo" },
            ],
          },
          {
            slug: "fashion-men-pants",
            labels: { en: "Pants", ro: "Pantaloni" },
            match: [
              { dep: "fashion", cat: "men", sub: "pants" },
              { dep: "fashion", cat: "men", sub: "pantaloni" },
              { dep: "fashion", cat: "men", sub: "suit pants" },
            ],
          },
          {
            slug: "fashion-men-jeans",
            labels: { en: "Jeans", ro: "Blugi" },
            match: [
              { dep: "fashion", cat: "men", sub: "jeans" },
              { dep: "fashion", cat: "men", sub: "blugi" },
              { dep: "fashion", cat: "men", sub: "denim (nou)" },
              { dep: "fashion", cat: "men", sub: "denim" },
            ],
          },
          {
            slug: "fashion-men-shorts",
            labels: { en: "Shorts", ro: "Pantaloni scurți" },
            match: [
              { dep: "fashion", cat: "men", sub: "shorts" },
              { dep: "fashion", cat: "men", sub: "board shorts" },
              { dep: "fashion", cat: "men", sub: "pantaloni scurți" },
              { dep: "fashion", cat: "men", sub: "costume de baie" },
            ],
          },
          {
            slug: "fashion-men-coats",
            labels: { en: "Coats & jackets", ro: "Paltoane și jachete" },
            match: [
              { dep: "fashion", cat: "men", sub: "paltoane și jachete" },
              { dep: "fashion", cat: "men", sub: "coats" },
              { dep: "fashion", cat: "men", sub: "jackets" },
              { dep: "fashion", cat: "men", sub: "outerwear & coats" },
              { dep: "fashion", cat: "men", sub: "overcoats" },
              { dep: "fashion", cat: "men", sub: "windbreakers" },
            ],
          },
          {
            slug: "fashion-men-hoodies",
            labels: { en: "Hoodies & sweatshirts", ro: "Hanorace și bluze" },
            match: [
              { dep: "fashion", cat: "men", sub: "hoodies" },
              { dep: "fashion", cat: "men", sub: "sweatshirts" },
              { dep: "fashion", cat: "men", sub: "hanorace & bluze" },
              { dep: "fashion", cat: "men", sub: "hanorace și bluze" },
            ],
          },
          {
            slug: "fashion-men-underwear",
            labels: { en: "Underwear", ro: "Lenjerie intimă bărbați" },
            match: [
              { dep: "fashion", cat: "men", sub: "underwear" },
              { dep: "fashion", cat: "men", sub: "long johns" },
              { dep: "fashion", cat: "men", sub: "sleepwear" },
              { dep: "fashion", cat: "men", sub: "lenjerie intimă bărbați" },
            ],
          },
        ],
      },
      {
        slug: "fashion-shoes", kind: "category",
        labels: { en: "Shoes", ro: "Încălțăminte" },
        match: [{ dep: "fashion", cat: "shoes" }],
        children: [
          { slug: "fashion-shoes-women", labels: { en: "Women's shoes", ro: "Încălțăminte damă" }, match: [{ dep: "fashion", cat: "shoes", sub: "women" }] },
          { slug: "fashion-shoes-men", labels: { en: "Men's shoes", ro: "Încălțăminte bărbați" }, match: [{ dep: "fashion", cat: "shoes", sub: "men" }] },
          { slug: "fashion-shoes-kids", labels: { en: "Kids shoes", ro: "Încălțăminte copii" }, match: [{ dep: "fashion", cat: "shoes", sub: "kids" }] },
          { slug: "fashion-shoes-accessories", labels: { en: "Shoe accessories", ro: "Accesorii încălțăminte" }, match: [{ dep: "fashion", cat: "shoes", sub: "accessories" }] },
        ],
      },
      {
        slug: "fashion-underwear", kind: "category",
        labels: { en: "Underwear & lingerie", ro: "Lenjerie intimă" },
        match: [{ dep: "fashion", cat: "underwear" }],
        children: [
          {
            slug: "fashion-underwear-women",
            labels: { en: "Women's lingerie", ro: "Lenjerie intimă damă" },
            match: [
              { dep: "fashion", cat: "underwear", sub: "lenjerie intimă damă" },
              { dep: "fashion", cat: "underwear", sub: "bustiere" },
              { dep: "fashion", cat: "underwear", sub: "furouri" },
              { dep: "fashion", cat: "underwear", sub: "women" },
              { dep: "fashion", cat: "underwear", sub: "pijamale și loungewear damă" },
            ],
          },
          {
            slug: "fashion-underwear-men",
            labels: { en: "Men's underwear", ro: "Lenjerie intimă bărbați" },
            match: [
              { dep: "fashion", cat: "underwear", sub: "men" },
              { dep: "fashion", cat: "underwear", sub: "lenjerie intimă bărbați" },
            ],
          },
          {
            slug: "fashion-underwear-socks",
            labels: { en: "Socks & hosiery", ro: "Șosete și ciorapi" },
            match: [
              { dep: "fashion", cat: "underwear", sub: "socks" },
              { dep: "fashion", cat: "underwear", sub: "șosete bărbați" },
              { dep: "fashion", cat: "underwear", sub: "șosete și ciorapi damă" },
            ],
          },
        ],
      },
      {
        slug: "fashion-accessories", kind: "category",
        labels: { en: "Accessories", ro: "Accesorii vestimentare" },
        match: [{ dep: "fashion", cat: "accessories" }],
        children: [
          {
            slug: "fashion-accessories-bags",
            labels: { en: "Bags & wallets", ro: "Genți și portofele" },
            match: [
              { dep: "fashion", cat: "accessories", sub: "bags" },
              { dep: "fashion", cat: "bags" },
              { dep: "fashion", cat: "bags", sub: "backpacks" },
              { dep: "fashion", cat: "bags", sub: "wallets" },
              { dep: "fashion", cat: "bags", sub: "handbags" },
              { dep: "fashion", cat: "bags", sub: "crossbody" },
              { dep: "fashion", cat: "bags", sub: "luggage" },
            ],
          },
          {
            slug: "fashion-accessories-jewelry",
            labels: { en: "Jewelry", ro: "Bijuterii" },
            match: [
              { dep: "fashion", cat: "accessories", sub: "jewelry" },
              { dep: "fashion", cat: "jewelry" },
              { dep: "fashion", cat: "jewelry", sub: "rings" },
              { dep: "fashion", cat: "jewelry", sub: "pendants" },
              { dep: "fashion", cat: "jewelry", sub: "earrings" },
              { dep: "fashion", cat: "jewelry", sub: "bracelets" },
              { dep: "fashion", cat: "jewelry", sub: "necklaces" },
              { dep: "fashion", cat: "jewelry", sub: "charms" },
            ],
          },
          {
            slug: "fashion-accessories-watches",
            labels: { en: "Watches", ro: "Ceasuri" },
            match: [
              { dep: "fashion", cat: "accessories", sub: "watches" },
              { dep: "fashion", cat: "watches" },
              { dep: "fashion", cat: "watches", sub: "men's watches" },
              { dep: "fashion", cat: "watches", sub: "women's watches" },
              { dep: "fashion", cat: "watches", sub: "couple watches" },
              { dep: "fashion", cat: "watches", sub: "kids watches" },
            ],
          },
          { slug: "fashion-accessories-hats", labels: { en: "Hats & caps", ro: "Pălării și șepci" }, match: [{ dep: "fashion", cat: "accessories", sub: "hats" }] },
        ],
      },
    ],
  },
  // ── BEAUTY ───────────────────────────────────────────────────────────────
  {
    slug: "beauty", kind: "department",
    labels: { en: "Beauty", ro: "Frumusețe" },
    aeRoots: ["66"],
    children: [
      {
        slug: "beauty-makeup", kind: "category",
        labels: { en: "Makeup", ro: "Machiaj" },
        match: [
          { dep: "beauty", cat: "makeup" },
          { dep: "beauty", cat: "health", sub: "machiaj" },
        ],
        children: [
          {
            slug: "beauty-makeup-face",
            labels: { en: "Face makeup", ro: "Machiaj ten" },
            match: [
              { dep: "beauty", cat: "makeup", sub: "face" },
              { dep: "beauty", cat: "health", sub: "face makeup" },
            ],
          },
          { slug: "beauty-makeup-eyes", labels: { en: "Eye makeup", ro: "Machiaj ochi" }, match: [{ dep: "beauty", cat: "makeup", sub: "eyes" }] },
          {
            slug: "beauty-makeup-lips",
            labels: { en: "Lip makeup", ro: "Machiaj buze" },
            match: [
              { dep: "beauty", cat: "makeup", sub: "lips" },
              { dep: "beauty", cat: "health", sub: "lip makeup" },
            ],
          },
          { slug: "beauty-makeup-nails", labels: { en: "Nail care", ro: "Manichiură" }, match: [{ dep: "beauty", cat: "makeup", sub: "nails" }] },
        ],
      },
      {
        slug: "beauty-skincare", kind: "category",
        labels: { en: "Skincare", ro: "Îngrijirea pielii" },
        match: [{ dep: "beauty", cat: "skincare" }],
        children: [
          { slug: "beauty-skincare-face", labels: { en: "Face care", ro: "Îngrijire ten" }, match: [{ dep: "beauty", cat: "skincare", sub: "face" }] },
          { slug: "beauty-skincare-body", labels: { en: "Body care", ro: "Îngrijire corp" }, match: [{ dep: "beauty", cat: "skincare", sub: "body" }] },
          { slug: "beauty-skincare-sun", labels: { en: "Sun care", ro: "Protecție solară" }, match: [{ dep: "beauty", cat: "skincare", sub: "sun" }] },
        ],
      },
      {
        slug: "beauty-haircare", kind: "category",
        labels: { en: "Hair care", ro: "Îngrijirea părului" },
        match: [
          { dep: "beauty", cat: "hair care" },
          { dep: "beauty", cat: "haircare" },
          { dep: "beauty", cat: "health", sub: "îngrijirea și styling-ul părului" },
        ],
        children: [
          { slug: "beauty-hair-styling", labels: { en: "Styling", ro: "Styling păr" }, match: [{ dep: "beauty", cat: "hair care", sub: "styling" }] },
          { slug: "beauty-hair-extensions", labels: { en: "Extensions & wigs", ro: "Extensii și peruci" }, match: [{ dep: "beauty", cat: "hair care", sub: "extensions" }] },
        ],
      },
      {
        slug: "beauty-fragrance", kind: "category",
        labels: { en: "Fragrance", ro: "Parfumuri" },
        match: [
          { dep: "beauty", cat: "fragrance" },
          { dep: "beauty", cat: "perfume" },
          { dep: "beauty", cat: "health", sub: "parfum" },
          { dep: "beauty", cat: "health", sub: "parfumuri și deodorante" },
        ],
      },
      {
        slug: "beauty-tools", kind: "category",
        labels: { en: "Beauty devices", ro: "Aparate de înfrumusețare" },
        match: [
          { dep: "beauty", cat: "tools" },
          { dep: "beauty", cat: "devices" },
          { dep: "beauty", cat: "health", sub: "aparate de înfrumusețare" },
        ],
      },
    ],
  },
  // ── ELECTRONICS ──────────────────────────────────────────────────────────
  {
    slug: "electronics", kind: "department",
    labels: { en: "Electronics", ro: "Electronice" },
    aeRoots: ["44", "509", "7", "1420"],
    children: [
      {
        slug: "electronics-phones", kind: "category",
        labels: { en: "Phones & accessories", ro: "Telefoane și accesorii" },
        match: [
          { dep: "electronics", cat: "phone accessories" },
          { dep: "electronics", cat: "phones" },
          { dep: "electronics", cat: "phones", sub: "telefoane mobile" },
          { dep: "electronics", cat: "phones", sub: "piese pentru telefoane mobile" },
          { dep: "electronics", cat: "phones", sub: "stații walkie talkie" },
        ],
        children: [
          {
            slug: "electronics-phones-sim",
            labels: { en: "SIM cards & adapters", ro: "Cartele SIM și accesorii" },
            match: [
              { dep: "electronics", cat: "phone accessories", sub: "cartele sim și accesorii" },
              { dep: "electronics", cat: "phone accessories", sub: "sim card" },
            ],
          },
          {
            slug: "electronics-phones-cases",
            labels: { en: "Cases & covers", ro: "Huse și carcase" },
            match: [
              { dep: "electronics", cat: "phone accessories", sub: "cases" },
              { dep: "electronics", cat: "phone accessories", sub: "huse de telefon" },
            ],
          },
          {
            slug: "electronics-phones-screen-protectors",
            labels: { en: "Screen protectors", ro: "Folii de protecție" },
            match: [
              { dep: "electronics", cat: "phone accessories", sub: "folii de protecție pentru telefon" },
              { dep: "electronics", cat: "phone accessories", sub: "screen protectors" },
            ],
          },
          {
            slug: "electronics-phones-chargers",
            labels: { en: "Chargers & cables", ro: "Încărcătoare și cabluri" },
            match: [
              { dep: "electronics", cat: "phone accessories", sub: "chargers" },
              { dep: "electronics", cat: "phone accessories", sub: "accesorii pentru telefon" },
            ],
          },
          {
            slug: "electronics-phones-camera-accessories",
            labels: { en: "Phone camera accessories", ro: "Accesorii foto telefon" },
            match: [
              { dep: "electronics", cat: "phone accessories", sub: "accesorii foto pentru telefon" },
            ],
          },
        ],
      },
      {
        slug: "electronics-audio", kind: "category",
        labels: { en: "Audio", ro: "Audio" },
        match: [{ dep: "electronics", cat: "audio" }, { dep: "electronics", cat: "headphones" }],
        children: [
          { slug: "electronics-audio-headphones", labels: { en: "Headphones & earbuds", ro: "Căști și airpods" }, match: [{ dep: "electronics", cat: "audio", sub: "headphones" }] },
          { slug: "electronics-audio-speakers", labels: { en: "Speakers", ro: "Boxe" }, match: [{ dep: "electronics", cat: "audio", sub: "speakers" }] },
        ],
      },
      { slug: "electronics-computing", kind: "category", labels: { en: "Computers & tablets", ro: "Computere și tablete" }, match: [{ dep: "electronics", cat: "computing" }, { dep: "electronics", cat: "computers" }] },
      { slug: "electronics-wearables", kind: "category", labels: { en: "Smartwatches & wearables", ro: "Smartwatch și wearables" }, match: [{ dep: "electronics", cat: "wearables" }, { dep: "electronics", cat: "smartwatch" }] },
      { slug: "electronics-cameras", kind: "category", labels: { en: "Cameras", ro: "Camere foto/video" }, match: [{ dep: "electronics", cat: "cameras" }] },
      { slug: "electronics-gaming", kind: "category", labels: { en: "Gaming", ro: "Gaming" }, match: [{ dep: "electronics", cat: "gaming" }] },
    ],
  },
  // ── HOME ─────────────────────────────────────────────────────────────────
  {
    slug: "home", kind: "department",
    labels: { en: "Home", ro: "Casă" },
    aeRoots: ["15", "1503"],
    children: [
      {
        slug: "home-appliances", kind: "category",
        labels: { en: "Appliances", ro: "Electrocasnice" },
        match: [
          { dep: "home", cat: "appliances" },
          { dep: "home", cat: "appliances", sub: "electrocasnice mari" },
        ],
        children: [
          {
            slug: "home-appliances-personal-care",
            labels: { en: "Personal care", ro: "Aparate de îngrijire personală" },
            match: [
              { dep: "home", cat: "appliances", sub: "aparate de îngrijire personală" },
              { dep: "home", cat: "appliances", sub: "personal care" },
            ],
          },
          {
            slug: "home-appliances-kitchen",
            labels: { en: "Kitchen appliances", ro: "Aparate de bucătărie" },
            match: [
              { dep: "home", cat: "appliances", sub: "kitchen" },
              { dep: "home", cat: "appliances", sub: "electrocasnice de bucătărie" },
            ],
          },
          { slug: "home-appliances-cleaning", labels: { en: "Cleaning appliances", ro: "Aparate de curățenie" }, match: [{ dep: "home", cat: "appliances", sub: "cleaning" }] },
        ],
      },
      { slug: "home-decor", kind: "category", labels: { en: "Decor", ro: "Decorațiuni" }, match: [{ dep: "home", cat: "decor" }] },
      { slug: "home-furniture", kind: "category", labels: { en: "Furniture", ro: "Mobilier" }, match: [{ dep: "home", cat: "furniture" }] },
      {
        slug: "home-textiles", kind: "category",
        labels: { en: "Bedding & textiles", ro: "Lenjerie de pat și textile" },
        match: [
          { dep: "home", cat: "textiles" },
          { dep: "home", cat: "bedding" },
          { dep: "home", cat: "garden", sub: "bedding" },
        ],
      },
      { slug: "home-kitchen", kind: "category", labels: { en: "Kitchen & dining", ro: "Bucătărie și servire" }, match: [{ dep: "home", cat: "kitchen" }] },
      { slug: "home-storage", kind: "category", labels: { en: "Storage & organization", ro: "Depozitare și organizare" }, match: [{ dep: "home", cat: "storage" }] },
      {
        slug: "home-bathroom", kind: "category",
        labels: { en: "Bathroom", ro: "Baie" },
        match: [
          { dep: "home", cat: "bathroom" },
          { dep: "home", cat: "garden", sub: "bathroom products" },
        ],
      },
    ],
  },
  // ── TOYS & KIDS ──────────────────────────────────────────────────────────
  {
    slug: "toys", kind: "department",
    labels: { en: "Toys & kids", ro: "Jucării și copii" },
    aeRoots: ["26", "1501"],
    children: [
      {
        slug: "toys-games", kind: "category",
        labels: { en: "Toys & games", ro: "Jucării" },
        match: [
          { dep: "toys", cat: "games" },
          { dep: "toys", cat: "toys" },
          { dep: "toys", cat: "kids", sub: "toys" },
          { dep: "toys", cat: "kids" },
          { dep: "toys", cat: "hobbies" },
          { dep: "toys", cat: "hobbies", sub: "action figures" },
          { dep: "toys", cat: "hobbies", sub: "model kits" },
          { dep: "toys", cat: "hobbies", sub: "collectibles" },
        ],
      },
      {
        slug: "toys-baby", kind: "category",
        labels: { en: "Baby gear", ro: "Articole bebe" },
        match: [
          { dep: "toys", cat: "baby" },
          { dep: "kids", cat: "general", sub: "maternity" },
        ],
      },
      { slug: "toys-school", kind: "category", labels: { en: "School supplies", ro: "Rechizite școlare" }, match: [{ dep: "toys", cat: "school" }] },
    ],
  },
  // ── SPORTS ───────────────────────────────────────────────────────────────
  {
    slug: "sports", kind: "department",
    labels: { en: "Sports & outdoors", ro: "Sport și outdoor" },
    aeRoots: ["18"],
    children: [
      { slug: "sports-fitness", kind: "category", labels: { en: "Fitness", ro: "Fitness" }, match: [{ dep: "sports", cat: "fitness" }] },
      {
        slug: "sports-outdoor", kind: "category",
        labels: { en: "Outdoor & camping", ro: "Outdoor și camping" },
        match: [
          { dep: "sports", cat: "outdoor" },
          { dep: "sports", cat: "outdoor", sub: "yoga clothing" },
          { dep: "sports", cat: "outdoor", sub: "fishing apparel" },
        ],
      },
      { slug: "sports-cycling", kind: "category", labels: { en: "Cycling", ro: "Ciclism" }, match: [{ dep: "sports", cat: "cycling" }] },
    ],
  },
  // ── AUTOMOTIVE ───────────────────────────────────────────────────────────
  {
    slug: "automotive", kind: "department",
    labels: { en: "Automotive", ro: "Auto și moto" },
    aeRoots: ["34"],
    children: [
      { slug: "auto-parts", kind: "category", labels: { en: "Parts", ro: "Piese auto" }, match: [{ dep: "automotive", cat: "parts" }] },
      { slug: "auto-accessories", kind: "category", labels: { en: "Accessories", ro: "Accesorii auto" }, match: [{ dep: "automotive", cat: "accessories" }] },
    ],
  },
  // ── HEALTH ───────────────────────────────────────────────────────────────
  {
    slug: "health", kind: "department",
    labels: { en: "Health & wellness", ro: "Sănătate și wellness" },
    aeRoots: [],
    match: [
      // catch-all: Beauty/Health (AE often misroutes wellness under Beauty dept)
      { dep: "beauty", cat: "health" },
    ],
    children: [
      {
        slug: "health-personal", kind: "category",
        labels: { en: "Personal care", ro: "Îngrijire personală" },
        match: [
          { dep: "health", cat: "personal" },
          { dep: "beauty", cat: "health", sub: "hârtie igienică" },
        ],
      },
      { slug: "health-supplements", kind: "category", labels: { en: "Supplements", ro: "Suplimente" }, match: [{ dep: "health", cat: "supplements" }] },
      {
        slug: "health-massage", kind: "category",
        labels: { en: "Massage & recovery", ro: "Masaj și recuperare" },
        match: [
          { dep: "health", cat: "massage" },
          { dep: "beauty", cat: "health", sub: "masaj și relaxare" },
          { dep: "beauty", cat: "health", sub: "articole de recuperare" },
        ],
      },
      {
        slug: "health-oral-care", kind: "category",
        labels: { en: "Oral care", ro: "Igienă orală" },
        match: [
          { dep: "health", cat: "oral" },
          { dep: "beauty", cat: "health", sub: "igienă orală" },
        ],
      },
      {
        slug: "health-adult", kind: "category",
        labels: { en: "Adult products", ro: "Produse pentru adulți" },
        match: [
          { dep: "health", cat: "adult" },
          { dep: "beauty", cat: "health", sub: "produse pentru adulți" },
        ],
      },
    ],
  },
  // ── OFFICE ───────────────────────────────────────────────────────────────
  {
    slug: "office", kind: "department",
    labels: { en: "Office", ro: "Birou" },
    aeRoots: [],
    children: [
      { slug: "office-supplies", kind: "category", labels: { en: "Office supplies", ro: "Articole de birou" }, match: [{ dep: "office", cat: "supplies" }] },
    ],
  },
  // ── TOOLS ────────────────────────────────────────────────────────────────
  {
    slug: "tools", kind: "department",
    labels: { en: "Tools & DIY", ro: "Unelte și bricolaj" },
    aeRoots: ["1420"],
    children: [
      { slug: "tools-hand", kind: "category", labels: { en: "Hand tools", ro: "Scule de mână" }, match: [{ dep: "tools", cat: "hand" }] },
      { slug: "tools-power", kind: "category", labels: { en: "Power tools", ro: "Scule electrice" }, match: [{ dep: "tools", cat: "power" }] },
    ],
  },
  // ── PETS ─────────────────────────────────────────────────────────────────
  {
    slug: "pets", kind: "department",
    labels: { en: "Pets", ro: "Animale de companie" },
    aeRoots: [],
    children: [
      { slug: "pets-supplies", kind: "category", labels: { en: "Pet supplies", ro: "Accesorii animale" }, match: [{ dep: "pets", cat: "supplies" }] },
    ],
  },
  { slug: "garden", kind: "department", labels: { en: "Garden & outdoor", ro: "Grădină și outdoor" }, aeRoots: [] },
  { slug: "food", kind: "department", labels: { en: "Food & beverages", ro: "Alimente și băuturi" }, aeRoots: [] },
  { slug: "other", kind: "department", labels: { en: "Other", ro: "Altele" }, aeRoots: [] },
];

export function flatten(tree, parent = null, kindFallback = "category") {
  const out = [];
  let order = 10;
  for (const node of tree) {
    const kind = node.kind || (parent === null ? "department" : kindFallback);
    out.push({
      slug: node.slug,
      parent_slug: parent,
      kind,
      sort_order: order,
      ae_roots: node.aeRoots || [],
      ae_leafs: node.aeLeafs || [],
      labels: node.labels,
      match: node.match || [],
    });
    order += 10;
    if (node.children?.length) {
      const childKind = kind === "department" ? "category" : kind === "category" ? "subcategory" : "leaf";
      out.push(...flatten(node.children, node.slug, childKind));
    }
  }
  return out;
}

function norm(s) {
  return (s || "").toString().trim().toLowerCase();
}

async function upsertNodes(client, flat) {
  for (const n of flat) {
    await client.query(
      `INSERT INTO taxonomy_nodes (slug, parent_slug, kind, sort_order, ae_root_ids, ae_leaf_ids)
       VALUES ($1, $2, $3, $4, $5::text[], $6::text[])
       ON CONFLICT (slug) DO UPDATE
         SET parent_slug = EXCLUDED.parent_slug,
             kind        = EXCLUDED.kind,
             sort_order  = EXCLUDED.sort_order,
             ae_root_ids = EXCLUDED.ae_root_ids,
             ae_leaf_ids = EXCLUDED.ae_leaf_ids,
             updated_at  = NOW()`,
      [n.slug, n.parent_slug, n.kind, n.sort_order, n.ae_roots, n.ae_leafs]
    );
    for (const [locale, label] of Object.entries(n.labels || {})) {
      await client.query(
        `INSERT INTO taxonomy_translations (node_slug, locale, label)
         VALUES ($1, $2, $3)
         ON CONFLICT (node_slug, locale) DO UPDATE SET label = EXCLUDED.label, updated_at = NOW()`,
        [n.slug, locale, label]
      );
    }
  }
}

/**
 * Build (dep|cat|sub) → slug lookup. More specific matches (with `sub`)
 * win over less specific (`cat`-only, then `dep`-only).
 */
export function buildMatcher(flat) {
  const exact = new Map();
  const catOnly = new Map();
  const depOnly = new Map();

  for (const n of flat) {
    for (const m of n.match || []) {
      const dep = norm(m.dep);
      const cat = norm(m.cat);
      const sub = norm(m.sub);
      if (dep && cat && sub) exact.set(`${dep}|${cat}|${sub}`, n.slug);
      else if (dep && cat) catOnly.set(`${dep}|${cat}`, n.slug);
      else if (dep) depOnly.set(dep, n.slug);
    }
    if (n.kind === "department") depOnly.set(norm(n.slug), n.slug);
  }
  return { exact, catOnly, depOnly };
}

export function resolveSlug(matcher, dep, cat, sub) {
  const d = norm(dep);
  const c = norm(cat);
  const s = norm(sub);
  if (d && c && s && matcher.exact.has(`${d}|${c}|${s}`)) return { slug: matcher.exact.get(`${d}|${c}|${s}`), confidence: 1.0 };
  if (d && c && matcher.catOnly.has(`${d}|${c}`)) return { slug: matcher.catOnly.get(`${d}|${c}`), confidence: 0.7 };
  if (d && matcher.depOnly.has(d)) return { slug: matcher.depOnly.get(d), confidence: 0.4 };
  return { slug: "other", confidence: 0.0 };
}

async function reclassifyProducts(client, matcher) {
  // Skip produse cu override manual (taxonomy_reason începe cu manual_) — fix-urile umane câștigă.
  const { rows } = await client.query(
    `SELECT id, taxonomy_department AS dep, taxonomy_category AS cat, taxonomy_subcategory AS sub
       FROM marketplace_products
      WHERE status IN ('active','draft')
        AND (taxonomy_reason IS NULL OR taxonomy_reason NOT LIKE 'manual_%')`
  );
  let exact = 0, catOnly = 0, depOnly = 0, fallback = 0, skipped = 0;
  for (const p of rows) {
    const r = resolveSlug(matcher, p.dep, p.cat, p.sub);
    if (r.confidence === 1.0) exact++;
    else if (r.confidence === 0.7) catOnly++;
    else if (r.confidence === 0.4) depOnly++;
    else fallback++;
    await client.query(
      `UPDATE marketplace_products
          SET taxonomy_node_slug   = $2,
              taxonomy_confidence  = $3,
              taxonomy_unresolved  = ($3 < 0.7),
              updated_at = NOW()
        WHERE id = $1`,
      [p.id, r.slug, r.confidence]
    );
  }
  const { rows: skipRows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM marketplace_products WHERE status IN ('active','draft') AND taxonomy_reason LIKE 'manual_%'`
  );
  skipped = skipRows[0]?.n ?? 0;
  return { total: rows.length, exact, catOnly, depOnly, fallback, skipped };
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const flat = flatten(TREE);
    console.log(`[seed] tree nodes: ${flat.length}`);
    await client.query("BEGIN");
    await upsertNodes(client, flat);
    await client.query("COMMIT");
    console.log(`[seed] upserted ${flat.length} nodes + translations`);

    const matcher = buildMatcher(flat);
    console.log(`[reclassify] starting…`);
    const stats = await reclassifyProducts(client, matcher);
    console.log(`[reclassify] ${JSON.stringify(stats)}`);

    const { rows: dist } = await client.query(
      `SELECT n.slug, t.label AS label_ro, COUNT(p.id)::int AS n
         FROM taxonomy_nodes n
         LEFT JOIN taxonomy_translations t ON t.node_slug = n.slug AND t.locale = 'ro'
         LEFT JOIN marketplace_products p ON p.taxonomy_node_slug = n.slug AND p.status='active'
        WHERE n.kind = 'department'
        GROUP BY n.slug, t.label, n.sort_order
        ORDER BY n.sort_order`
    );
    console.log(`[dist] department counts:`);
    for (const r of dist) console.log(`  ${r.slug.padEnd(15)} ${r.label_ro?.padEnd(20) || ""} ${r.n}`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
