-- Seed: 8 community posts + 5 missions linked to real products
-- Idempotent via slug uniqueness

\set SYS '00000000-0000-0000-0000-000000000001'

-- ============================================================
-- BATTLES (versus 2 produse)
-- ============================================================

-- BATTLE 1: Swimwear summer
INSERT INTO community_posts (slug, author_user_id, format, title, body, status, is_adult, ends_at, hot_score, metadata)
VALUES (
  'battle-swimwear-summer-2026',
  :'SYS', 'battle',
  'Vară 2026: bermude bărbați sau costum dama lotus?',
  'Care e win-ul pentru plajă anul ăsta? Votează preferatul. Battle se închide în 7 zile.',
  'active', false,
  now() + interval '7 days',
  85.50,
  '{"seeded":true,"category":"fashion"}'::jsonb
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'A', 'Bermude Hawaii Print', 0
FROM community_posts p, marketplace_products mp
WHERE p.slug='battle-swimwear-summer-2026' AND mp.slug LIKE '2024-summer-new-hawaii-vacation-beach-shorts%'
ON CONFLICT DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'B', 'Costum dama Lotus Edge', 1
FROM community_posts p, marketplace_products mp
WHERE p.slug='battle-swimwear-summer-2026' AND mp.slug LIKE 'one-piece-women-swimwear-lotus%'
ON CONFLICT DO NOTHING;

-- BATTLE 2: Office outfit women
INSERT INTO community_posts (slug, author_user_id, format, title, body, status, is_adult, ends_at, hot_score, metadata)
VALUES (
  'battle-office-outfit-2026',
  :'SYS', 'battle',
  'Outfit office: costum 2 piese sau rochie petrecere?',
  'Plecăm la birou sau la party după? Ce alegi?',
  'active', false,
  now() + interval '5 days',
  72.30,
  '{"seeded":true,"category":"fashion-women"}'::jsonb
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'A', 'Costum 2 piese Black Wide Leg', 0
FROM community_posts p, marketplace_products mp
WHERE p.slug='battle-office-outfit-2026' AND mp.slug LIKE 'women-black-two-piece-set-stand-collar%'
ON CONFLICT DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'B', 'Rochie Ruffled Mini Print', 1
FROM community_posts p, marketplace_products mp
WHERE p.slug='battle-office-outfit-2026' AND mp.slug LIKE 'tossy-fashion-ruffled-elegant-party-dress%'
ON CONFLICT DO NOTHING;

-- BATTLE 3: Men casual pants
INSERT INTO community_posts (slug, author_user_id, format, title, body, status, is_adult, ends_at, hot_score, metadata)
VALUES (
  'battle-men-casual-pants',
  :'SYS', 'battle',
  'Pantaloni bărbați: jeans elastici sau fleece warm?',
  'Confort maxim, dar care e win-ul? Votează.',
  'active', false,
  now() + interval '6 days',
  68.10,
  '{"seeded":true,"category":"fashion-men"}'::jsonb
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'A', 'Jeans Elastic Cotton Korea', 0
FROM community_posts p, marketplace_products mp
WHERE p.slug='battle-men-casual-pants' AND mp.slug LIKE 'high-quality-fully-elastic-waist-men-s-jeans%'
ON CONFLICT DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'B', 'Fleece Warm Plus Size', 1
FROM community_posts p, marketplace_products mp
WHERE p.slug='battle-men-casual-pants' AND mp.slug LIKE 'casual-warm-fleece-and-thickened%'
ON CONFLICT DO NOTHING;

-- ============================================================
-- MERITA (1 produs - "merită prețul?")
-- ============================================================

INSERT INTO community_posts (slug, author_user_id, format, title, body, status, is_adult, ends_at, hot_score, metadata)
VALUES (
  'merita-luxury-tshirt-2025',
  :'SYS', 'merita',
  'Merită 181 RON pentru un T-shirt "luxury brand"?',
  'Cotton pure, unisex, street wear. Worth? Vot YES/NO.',
  'active', false,
  now() + interval '4 days',
  62.40,
  '{"seeded":true,"category":"fashion-men"}'::jsonb
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'YES', 'Da, merită', 0
FROM community_posts p, marketplace_products mp
WHERE p.slug='merita-luxury-tshirt-2025' AND mp.slug LIKE '2025-autumn-winter-luxury-brand-letter%'
ON CONFLICT DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'NO', 'Nu, prea scump', 1
FROM community_posts p, marketplace_products mp
WHERE p.slug='merita-luxury-tshirt-2025' AND mp.slug LIKE '2025-autumn-winter-luxury-brand-letter%'
ON CONFLICT DO NOTHING;

INSERT INTO community_posts (slug, author_user_id, format, title, body, status, is_adult, ends_at, hot_score, metadata)
VALUES (
  'merita-winter-jacket',
  :'SYS', 'merita',
  'Geacă iarnă 385 RON — investiție bună?',
  'O-neck, long sleeves, buttoned. Cumperi sau treci?',
  'active', false,
  now() + interval '6 days',
  55.80,
  '{"seeded":true,"category":"fashion-women"}'::jsonb
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'YES', 'Da, merită', 0
FROM community_posts p, marketplace_products mp
WHERE p.slug='merita-winter-jacket' AND mp.slug LIKE 'women-s-autumn-winter-jacket-casual%'
ON CONFLICT DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'NO', 'Nu, am alternative', 1
FROM community_posts p, marketplace_products mp
WHERE p.slug='merita-winter-jacket' AND mp.slug LIKE 'women-s-autumn-winter-jacket-casual%'
ON CONFLICT DO NOTHING;

-- ============================================================
-- DROP — curated picks (mai multe produse într-un post)
-- ============================================================

INSERT INTO community_posts (slug, author_user_id, format, title, body, status, is_adult, ends_at, hot_score, metadata)
VALUES (
  'drop-y2k-vibes-cute-tops',
  :'SYS', 'drop',
  'DROP: Y2K vibes — top picks pentru summer',
  'Curated drop cu Y2K crop top + matching set. Click pe ce-ți place.',
  'active', false,
  now() + interval '10 days',
  78.20,
  '{"seeded":true,"category":"fashion-women","style":"y2k"}'::jsonb
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'crop', 'Y2K Crop Top Gothic', 0
FROM community_posts p, marketplace_products mp
WHERE p.slug='drop-y2k-vibes-cute-tops' AND mp.slug LIKE 'harajuku-crop-tops-y2k%'
ON CONFLICT DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'set', 'CM.YAYA Print Bow Set', 1
FROM community_posts p, marketplace_products mp
WHERE p.slug='drop-y2k-vibes-cute-tops' AND mp.slug LIKE 'cm-yaya-women-s-dress-set-print-bow%'
ON CONFLICT DO NOTHING;

-- ============================================================
-- DUPE_HUNT
-- ============================================================

INSERT INTO community_posts (slug, author_user_id, format, title, body, status, is_adult, ends_at, hot_score, metadata)
VALUES (
  'dupe-hunt-polo-luxury',
  :'SYS', 'dupe_hunt',
  'Dupe hunt: polo "GS Adventure" — la 154 RON e fake-luxury?',
  'Lapel collar, breathable. Compari cu brand-uri originale? Help us decide.',
  'active', false,
  now() + interval '5 days',
  44.10,
  '{"seeded":true,"category":"fashion-men"}'::jsonb
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'DUPE', 'E un dupe bun', 0
FROM community_posts p, marketplace_products mp
WHERE p.slug='dupe-hunt-polo-luxury' AND mp.slug LIKE 'gs-adventure-motorcycle%'
ON CONFLICT DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'FAKE', 'Nope, cash grab', 1
FROM community_posts p, marketplace_products mp
WHERE p.slug='dupe-hunt-polo-luxury' AND mp.slug LIKE 'gs-adventure-motorcycle%'
ON CONFLICT DO NOTHING;

-- ============================================================
-- SETUP (lifestyle bundle)
-- ============================================================

INSERT INTO community_posts (slug, author_user_id, format, title, body, status, is_adult, ends_at, hot_score, metadata)
VALUES (
  'setup-men-business-casual',
  :'SYS', 'setup',
  'Setup: business casual pentru bărbați — 3 piese key',
  'Outfit complet sub 600 RON. Votează item-ul tău preferat.',
  'active', false,
  now() + interval '8 days',
  51.70,
  '{"seeded":true,"category":"fashion-men"}'::jsonb
) ON CONFLICT (slug) DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'top', 'Polo GS Adventure', 0
FROM community_posts p, marketplace_products mp
WHERE p.slug='setup-men-business-casual' AND mp.slug LIKE 'gs-adventure-motorcycle%'
ON CONFLICT DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'mid', 'Check Pattern 2-piece', 1
FROM community_posts p, marketplace_products mp
WHERE p.slug='setup-men-business-casual' AND mp.slug LIKE 'new-autumn-men-s-check-pattern%'
ON CONFLICT DO NOTHING;

INSERT INTO community_post_items (post_id, product_id, option_key, label, position)
SELECT p.id, mp.id, 'bottom', 'Jeans Korea Elastic', 2
FROM community_posts p, marketplace_products mp
WHERE p.slug='setup-men-business-casual' AND mp.slug LIKE 'high-quality-fully-elastic-waist-men-s-jeans%'
ON CONFLICT DO NOTHING;

-- ============================================================
-- CREATOR MISSIONS (5)
-- ============================================================

INSERT INTO creator_missions (slug, product_id, title, brief, format_hint, prize_amount_minor, prize_currency, bounty_per_sale_minor, ends_at, status, metadata)
SELECT 'mission-summer-swim-haul', mp.id,
  'Summer Swim Haul — try-on video',
  'Filmează un try-on cu bermudele Hawaii Print pe plajă/piscină. Min. 15 sec, vertical 9:16, music allowed.',
  'try_on', 5000, 'RON', 500,
  now() + interval '14 days', 'active',
  '{"seeded":true}'::jsonb
FROM marketplace_products mp WHERE mp.slug LIKE '2024-summer-new-hawaii-vacation-beach-shorts%' LIMIT 1
ON CONFLICT (slug) DO NOTHING;

INSERT INTO creator_missions (slug, product_id, title, brief, format_hint, prize_amount_minor, prize_currency, bounty_per_sale_minor, ends_at, status, metadata)
SELECT 'mission-office-styling-3-ways', mp.id,
  'Office styling — 3 ways with this 2-piece',
  'Creează un video care arată 3 outfit-uri diferite cu costumul Black Wide Leg. Bonus pentru voice-over.',
  'styling', 8000, 'RON', 1000,
  now() + interval '21 days', 'active',
  '{"seeded":true}'::jsonb
FROM marketplace_products mp WHERE mp.slug LIKE 'women-black-two-piece-set-stand-collar%' LIMIT 1
ON CONFLICT (slug) DO NOTHING;

INSERT INTO creator_missions (slug, product_id, title, brief, format_hint, prize_amount_minor, prize_currency, bounty_per_sale_minor, ends_at, status, metadata)
SELECT 'mission-y2k-aesthetic-grwm', mp.id,
  'Y2K aesthetic — GRWM cu crop top',
  'Get Ready With Me în vibe Y2K folosind Harajuku Crop Top. Voice-over RO/EN OK.',
  'grwm', 6000, 'RON', 700,
  now() + interval '12 days', 'active',
  '{"seeded":true}'::jsonb
FROM marketplace_products mp WHERE mp.slug LIKE 'harajuku-crop-tops-y2k%' LIMIT 1
ON CONFLICT (slug) DO NOTHING;

INSERT INTO creator_missions (slug, product_id, title, brief, format_hint, prize_amount_minor, prize_currency, bounty_per_sale_minor, ends_at, status, metadata)
SELECT 'mission-luxury-tshirt-honest-review', mp.id,
  'Honest review — Luxury Brand T-shirt',
  'Test "luxury" la 181 RON. Quality unboxing + 3 puncte forte/slabe. Onestitate apreciată.',
  'review', 7500, 'RON', 800,
  now() + interval '10 days', 'active',
  '{"seeded":true}'::jsonb
FROM marketplace_products mp WHERE mp.slug LIKE '2025-autumn-winter-luxury-brand-letter%' LIMIT 1
ON CONFLICT (slug) DO NOTHING;

INSERT INTO creator_missions (slug, product_id, title, brief, format_hint, prize_amount_minor, prize_currency, bounty_per_sale_minor, ends_at, status, metadata)
SELECT 'mission-winter-jacket-vlog', mp.id,
  'Winter jacket vlog — outfit of the day',
  'Vlog 30 sec — geacă iarnă + 2 outfit-uri casual și smart. Outdoor preferred.',
  'vlog', 10000, 'RON', 1500,
  now() + interval '20 days', 'active',
  '{"seeded":true}'::jsonb
FROM marketplace_products mp WHERE mp.slug LIKE 'women-s-autumn-winter-jacket-casual%' LIMIT 1
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- VERIFY
-- ============================================================

\echo '=== posts inserted ==='
SELECT slug, format, vote_count, ends_at::date FROM community_posts WHERE metadata @> '{"seeded":true}'::jsonb ORDER BY hot_score DESC;

\echo '=== post items count ==='
SELECT cp.slug, count(cpi.id) AS items
FROM community_posts cp LEFT JOIN community_post_items cpi ON cpi.post_id=cp.id
WHERE cp.metadata @> '{"seeded":true}'::jsonb
GROUP BY cp.slug ORDER BY cp.slug;

\echo '=== missions ==='
SELECT slug, title, prize_amount_minor, ends_at::date FROM creator_missions WHERE metadata @> '{"seeded":true}'::jsonb ORDER BY slug;
