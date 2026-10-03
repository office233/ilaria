-- ============================================================================
-- Subcategorii pentru verticalele consolidate (shop / build / farm / food /
-- real-estate / vehicles). Oglindește lib/verticals/catalog.ts → subcategories.
-- Idempotent.
-- ============================================================================

-- Departament nou: construcții
INSERT INTO taxonomy_nodes (slug, parent_slug, kind, sort_order, is_active, metadata) VALUES
  ('build', NULL, 'department', 10, true, '{"vertical":"build"}')
ON CONFLICT (slug) DO NOTHING;

-- ─── shop/* (domeniile de comerț devin subcategorii ale Shop) ──────────────
INSERT INTO taxonomy_nodes (slug, parent_slug, kind, sort_order, is_active, metadata) VALUES
  ('shop/fashion',      'shop', 'category', 1,  true, '{}'),
  ('shop/tech',         'shop', 'category', 2,  true, '{}'),
  ('shop/home',         'shop', 'category', 3,  true, '{}'),
  ('shop/beauty',       'shop', 'category', 4,  true, '{}'),
  ('shop/kids',         'shop', 'category', 5,  true, '{}'),
  ('shop/pets',         'shop', 'category', 6,  true, '{}'),
  ('shop/sports',       'shop', 'category', 7,  true, '{}'),
  ('shop/books',        'shop', 'category', 8,  true, '{}'),
  ('shop/music',        'shop', 'category', 9,  true, '{}'),
  ('shop/art',          'shop', 'category', 10, true, '{}'),
  ('shop/jewelry',      'shop', 'category', 11, true, '{}'),
  ('shop/office',       'shop', 'category', 12, true, '{}'),
  ('shop/industrial',   'shop', 'category', 13, true, '{}'),
  ('shop/agriculture',  'shop', 'category', 14, true, '{}'),
  ('shop/medical',      'shop', 'category', 15, true, '{}'),
  ('shop/collectibles', 'shop', 'category', 16, true, '{}'),
  -- build/*
  ('build/materials',  'build', 'category', 1, true, '{}'),
  ('build/tools',      'build', 'category', 2, true, '{}'),
  ('build/electrical', 'build', 'category', 3, true, '{}'),
  ('build/plumbing',   'build', 'category', 4, true, '{}'),
  ('build/paint',      'build', 'category', 5, true, '{}'),
  ('build/flooring',   'build', 'category', 6, true, '{}'),
  ('build/doors',      'build', 'category', 7, true, '{}'),
  ('build/heavy',      'build', 'category', 8, true, '{}'),
  -- farm/* (wine e nou)
  ('farm/wine', 'farm', 'category', 6, true, '{}'),
  -- food/*
  ('food/pizza',    'food', 'category', 1, true, '{}'),
  ('food/burgers',  'food', 'category', 2, true, '{}'),
  ('food/asian',    'food', 'category', 3, true, '{}'),
  ('food/romanian', 'food', 'category', 4, true, '{}'),
  ('food/desserts', 'food', 'category', 5, true, '{}'),
  ('food/healthy',  'food', 'category', 6, true, '{}')
ON CONFLICT (slug) DO NOTHING;

-- ─── Traduceri ─────────────────────────────────────────────────────────────
INSERT INTO taxonomy_translations (node_slug, locale, label) VALUES
  ('build','ro','Construcții'), ('build','en','Building'), ('build','de','Bau'),
  ('shop/fashion','ro','Modă'), ('shop/fashion','en','Fashion'), ('shop/fashion','de','Mode'),
  ('shop/tech','ro','Electronice'), ('shop/tech','en','Tech'), ('shop/tech','de','Technik'),
  ('shop/home','ro','Casă & Grădină'), ('shop/home','en','Home & Garden'), ('shop/home','de','Haus & Garten'),
  ('shop/beauty','ro','Frumusețe'), ('shop/beauty','en','Beauty'), ('shop/beauty','de','Beauty'),
  ('shop/kids','ro','Copii'), ('shop/kids','en','Kids'), ('shop/kids','de','Kinder'),
  ('shop/pets','ro','Animale'), ('shop/pets','en','Pets'), ('shop/pets','de','Haustiere'),
  ('shop/sports','ro','Sport'), ('shop/sports','en','Sports'), ('shop/sports','de','Sport'),
  ('shop/books','ro','Cărți'), ('shop/books','en','Books'), ('shop/books','de','Bücher'),
  ('shop/music','ro','Muzică'), ('shop/music','en','Music'), ('shop/music','de','Musik'),
  ('shop/art','ro','Artă'), ('shop/art','en','Art'), ('shop/art','de','Kunst'),
  ('shop/jewelry','ro','Bijuterii'), ('shop/jewelry','en','Jewelry'), ('shop/jewelry','de','Schmuck'),
  ('shop/office','ro','Birou'), ('shop/office','en','Office'), ('shop/office','de','Büro'),
  ('shop/industrial','ro','Industrial'), ('shop/industrial','en','Industrial'), ('shop/industrial','de','Industrie'),
  ('shop/agriculture','ro','Agricultură'), ('shop/agriculture','en','Agriculture'), ('shop/agriculture','de','Landwirtschaft'),
  ('shop/medical','ro','Medical'), ('shop/medical','en','Medical'), ('shop/medical','de','Medizin'),
  ('shop/collectibles','ro','Colecții'), ('shop/collectibles','en','Collectibles'), ('shop/collectibles','de','Sammlerstücke'),
  ('build/materials','ro','Materiale'), ('build/materials','en','Materials'), ('build/materials','de','Baustoffe'),
  ('build/tools','ro','Scule'), ('build/tools','en','Tools'), ('build/tools','de','Werkzeuge'),
  ('build/electrical','ro','Electrice'), ('build/electrical','en','Electrical'), ('build/electrical','de','Elektrik'),
  ('build/plumbing','ro','Instalații'), ('build/plumbing','en','Plumbing'), ('build/plumbing','de','Sanitär'),
  ('build/paint','ro','Vopsele'), ('build/paint','en','Paint'), ('build/paint','de','Farben'),
  ('build/flooring','ro','Pardoseli'), ('build/flooring','en','Flooring'), ('build/flooring','de','Bodenbeläge'),
  ('build/doors','ro','Uși & Ferestre'), ('build/doors','en','Doors & Windows'), ('build/doors','de','Türen & Fenster'),
  ('build/heavy','ro','Utilaje'), ('build/heavy','en','Heavy Equipment'), ('build/heavy','de','Baumaschinen'),
  ('farm/wine','ro','Vin'), ('farm/wine','en','Wine'), ('farm/wine','de','Wein'),
  ('food/pizza','ro','Pizza'), ('food/pizza','en','Pizza'), ('food/pizza','de','Pizza'),
  ('food/burgers','ro','Burgeri'), ('food/burgers','en','Burgers'), ('food/burgers','de','Burger'),
  ('food/asian','ro','Asiatic'), ('food/asian','en','Asian'), ('food/asian','de','Asiatisch'),
  ('food/romanian','ro','Românesc'), ('food/romanian','en','Local'), ('food/romanian','de','Regional'),
  ('food/desserts','ro','Deserturi'), ('food/desserts','en','Desserts'), ('food/desserts','de','Desserts'),
  ('food/healthy','ro','Sănătos'), ('food/healthy','en','Healthy'), ('food/healthy','de','Gesund')
ON CONFLICT DO NOTHING;
