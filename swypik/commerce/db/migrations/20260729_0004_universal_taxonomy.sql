-- ============================================================================
-- Taxonomia universală — un departament per verticală din lib/verticals/catalog.ts
-- Idempotent. Nu atinge nodurile existente (real-estate, vehicles, services,
-- food, vacation-rentals au fost create în 0001 și 0003).
-- ============================================================================

-- ─── Departamente de comerț ─────────────────────────────────────────────────
INSERT INTO taxonomy_nodes (slug, parent_slug, kind, sort_order, is_active, metadata) VALUES
  ('shop',    NULL, 'department', 1,  true, '{"vertical":"shop"}'),
  ('fashion', NULL, 'department', 2,  true, '{"vertical":"fashion"}'),
  ('tech',    NULL, 'department', 3,  true, '{"vertical":"tech"}'),
  ('home',    NULL, 'department', 4,  true, '{"vertical":"home"}'),
  ('beauty',  NULL, 'department', 5,  true, '{"vertical":"beauty"}'),
  ('kids',    NULL, 'department', 6,  true, '{"vertical":"kids"}'),
  ('pets',    NULL, 'department', 7,  true, '{"vertical":"pets"}'),
  ('sports',  NULL, 'department', 8,  true, '{"vertical":"sports"}'),
  ('farm',    NULL, 'department', 9,  true, '{"vertical":"farm","local_only":true}'),
  -- livrare locală
  ('grocery',  NULL, 'department', 20, true, '{"vertical":"market","local_only":true}'),
  ('pharmacy', NULL, 'department', 21, true, '{"vertical":"pharma","local_only":true}'),
  ('flowers',  NULL, 'department', 22, true, '{"vertical":"flowers","local_only":true}'),
  ('drinks',   NULL, 'department', 23, true, '{"vertical":"drinks","local_only":true,"adult":true}'),
  ('courier',  NULL, 'department', 24, true, '{"vertical":"send","local_only":true}'),
  -- proprietăți & turism
  ('rentals', NULL, 'department', 30, true, '{"vertical":"rentals","local_only":true}'),
  ('trips',   NULL, 'department', 31, true, '{"vertical":"trips"}'),
  ('events',  NULL, 'department', 32, true, '{"vertical":"events"}'),
  ('flights', NULL, 'department', 33, true, '{"vertical":"fly"}'),
  -- muncă
  ('jobs', NULL, 'department', 40, true, '{"vertical":"jobs"}'),
  -- mobilitate
  ('rides', NULL, 'department', 41, true, '{"vertical":"go","local_only":true}')
ON CONFLICT (slug) DO NOTHING;

-- ─── Categorii noi sub `services` (pentru verticalele de servicii) ──────────
INSERT INTO taxonomy_nodes (slug, parent_slug, kind, sort_order, is_active, metadata) VALUES
  ('services/health',       'services', 'category', 6,  true, '{"vertical":"health"}'),
  ('services/fitness',      'services', 'category', 7,  true, '{"vertical":"fit"}'),
  ('services/auto-service', 'services', 'category', 8,  true, '{"vertical":"service"}'),
  ('services/care',         'services', 'category', 9,  true, '{"vertical":"care"}'),
  ('services/business',     'services', 'category', 10, true, '{"vertical":"biz"}')
ON CONFLICT (slug) DO NOTHING;

-- ─── Subcategorii pentru comerț (schelet minimal, se extinde din admin) ─────
INSERT INTO taxonomy_nodes (slug, parent_slug, kind, sort_order, is_active, metadata) VALUES
  ('fashion/women',      'fashion', 'category', 1, true, '{}'),
  ('fashion/men',        'fashion', 'category', 2, true, '{}'),
  ('fashion/shoes',      'fashion', 'category', 3, true, '{}'),
  ('fashion/accessories','fashion', 'category', 4, true, '{}'),
  ('tech/phones',        'tech',    'category', 1, true, '{}'),
  ('tech/computers',     'tech',    'category', 2, true, '{}'),
  ('tech/audio',         'tech',    'category', 3, true, '{}'),
  ('tech/gaming',        'tech',    'category', 4, true, '{}'),
  ('home/furniture',     'home',    'category', 1, true, '{}'),
  ('home/decor',         'home',    'category', 2, true, '{}'),
  ('home/garden',        'home',    'category', 3, true, '{}'),
  ('home/diy',           'home',    'category', 4, true, '{}'),
  ('farm/vegetables',    'farm',    'category', 1, true, '{}'),
  ('farm/fruits',        'farm',    'category', 2, true, '{}'),
  ('farm/dairy',         'farm',    'category', 3, true, '{}'),
  ('farm/meat',          'farm',    'category', 4, true, '{}'),
  ('farm/honey',         'farm',    'category', 5, true, '{}')
ON CONFLICT (slug) DO NOTHING;

-- ─── Traduceri RO / EN / DE ────────────────────────────────────────────────
INSERT INTO taxonomy_translations (node_slug, locale, label) VALUES
  ('shop','ro','Produse'), ('shop','en','Shop'), ('shop','de','Shop'),
  ('fashion','ro','Modă'), ('fashion','en','Fashion'), ('fashion','de','Mode'),
  ('tech','ro','Electronice'), ('tech','en','Tech'), ('tech','de','Technik'),
  ('home','ro','Casă & Grădină'), ('home','en','Home & Garden'), ('home','de','Haus & Garten'),
  ('beauty','ro','Frumusețe'), ('beauty','en','Beauty'), ('beauty','de','Beauty'),
  ('kids','ro','Copii'), ('kids','en','Kids'), ('kids','de','Kinder'),
  ('pets','ro','Animale'), ('pets','en','Pets'), ('pets','de','Haustiere'),
  ('sports','ro','Sport'), ('sports','en','Sports'), ('sports','de','Sport'),
  ('farm','ro','De la fermă'), ('farm','en','Farm Fresh'), ('farm','de','Vom Bauernhof'),
  ('grocery','ro','Alimente'), ('grocery','en','Groceries'), ('grocery','de','Lebensmittel'),
  ('pharmacy','ro','Farmacie'), ('pharmacy','en','Pharmacy'), ('pharmacy','de','Apotheke'),
  ('flowers','ro','Flori & Cadouri'), ('flowers','en','Flowers & Gifts'), ('flowers','de','Blumen & Geschenke'),
  ('drinks','ro','Băuturi'), ('drinks','en','Drinks'), ('drinks','de','Getränke'),
  ('courier','ro','Curierat'), ('courier','en','Courier'), ('courier','de','Kurier'),
  ('rentals','ro','Închirieri'), ('rentals','en','Rentals'), ('rentals','de','Vermietung'),
  ('trips','ro','Excursii'), ('trips','en','Trips'), ('trips','de','Ausflüge'),
  ('events','ro','Evenimente'), ('events','en','Events'), ('events','de','Veranstaltungen'),
  ('flights','ro','Zboruri'), ('flights','en','Flights'), ('flights','de','Flüge'),
  ('jobs','ro','Joburi'), ('jobs','en','Jobs'), ('jobs','de','Jobs'),
  ('rides','ro','Transport'), ('rides','en','Rides'), ('rides','de','Fahrten'),
  ('services/health','ro','Sănătate'), ('services/health','en','Health'), ('services/health','de','Gesundheit'),
  ('services/fitness','ro','Fitness'), ('services/fitness','en','Fitness'), ('services/fitness','de','Fitness'),
  ('services/auto-service','ro','Service auto'), ('services/auto-service','en','Auto Service'), ('services/auto-service','de','Autowerkstatt'),
  ('services/care','ro','Curățenie & Îngrijire'), ('services/care','en','Cleaning & Care'), ('services/care','de','Reinigung & Pflege'),
  ('services/business','ro','Servicii business'), ('services/business','en','Business Services'), ('services/business','de','Unternehmensdienste'),
  ('fashion/women','ro','Femei'), ('fashion/women','en','Women'), ('fashion/women','de','Damen'),
  ('fashion/men','ro','Bărbați'), ('fashion/men','en','Men'), ('fashion/men','de','Herren'),
  ('fashion/shoes','ro','Încălțăminte'), ('fashion/shoes','en','Shoes'), ('fashion/shoes','de','Schuhe'),
  ('fashion/accessories','ro','Accesorii'), ('fashion/accessories','en','Accessories'), ('fashion/accessories','de','Accessoires'),
  ('tech/phones','ro','Telefoane'), ('tech/phones','en','Phones'), ('tech/phones','de','Handys'),
  ('tech/computers','ro','Calculatoare'), ('tech/computers','en','Computers'), ('tech/computers','de','Computer'),
  ('tech/audio','ro','Audio'), ('tech/audio','en','Audio'), ('tech/audio','de','Audio'),
  ('tech/gaming','ro','Gaming'), ('tech/gaming','en','Gaming'), ('tech/gaming','de','Gaming'),
  ('home/furniture','ro','Mobilă'), ('home/furniture','en','Furniture'), ('home/furniture','de','Möbel'),
  ('home/decor','ro','Decorațiuni'), ('home/decor','en','Decor'), ('home/decor','de','Deko'),
  ('home/garden','ro','Grădină'), ('home/garden','en','Garden'), ('home/garden','de','Garten'),
  ('home/diy','ro','Bricolaj'), ('home/diy','en','DIY'), ('home/diy','de','Heimwerken'),
  ('farm/vegetables','ro','Legume'), ('farm/vegetables','en','Vegetables'), ('farm/vegetables','de','Gemüse'),
  ('farm/fruits','ro','Fructe'), ('farm/fruits','en','Fruits'), ('farm/fruits','de','Obst'),
  ('farm/dairy','ro','Lactate'), ('farm/dairy','en','Dairy'), ('farm/dairy','de','Milchprodukte'),
  ('farm/meat','ro','Carne'), ('farm/meat','en','Meat'), ('farm/meat','de','Fleisch'),
  ('farm/honey','ro','Miere'), ('farm/honey','en','Honey'), ('farm/honey','de','Honig')
ON CONFLICT DO NOTHING;
