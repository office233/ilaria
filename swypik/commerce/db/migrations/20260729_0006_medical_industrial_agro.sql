-- Verticale separate: Medical, Industrial, Agro (extrase din Shop).
-- Idempotent.

INSERT INTO taxonomy_nodes (slug, parent_slug, kind, sort_order, is_active, metadata) VALUES
  ('medical',    NULL, 'department', 11, true, '{"vertical":"medical"}'),
  ('industrial', NULL, 'department', 12, true, '{"vertical":"industrial"}'),
  ('agro',       NULL, 'department', 13, true, '{"vertical":"agro"}'),
  ('medical/devices',     'medical',    'category', 1, true, '{}'),
  ('medical/consumables', 'medical',    'category', 2, true, '{}'),
  ('medical/mobility',    'medical',    'category', 3, true, '{}'),
  ('medical/dental',      'medical',    'category', 4, true, '{}'),
  ('medical/lab',         'medical',    'category', 5, true, '{}'),
  ('medical/orthopedic',  'medical',    'category', 6, true, '{}'),
  ('industrial/machines',  'industrial', 'category', 1, true, '{}'),
  ('industrial/packaging', 'industrial', 'category', 2, true, '{}'),
  ('industrial/safety',    'industrial', 'category', 3, true, '{}'),
  ('industrial/horeca',    'industrial', 'category', 4, true, '{}'),
  ('agro/tractors',   'agro', 'category', 1, true, '{}'),
  ('agro/seeds',      'agro', 'category', 2, true, '{}'),
  ('agro/livestock',  'agro', 'category', 3, true, '{}'),
  ('agro/irrigation', 'agro', 'category', 4, true, '{}')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO taxonomy_translations (node_slug, locale, label) VALUES
  ('medical','ro','Medical'), ('medical','en','Medical'), ('medical','de','Medizin'),
  ('industrial','ro','Industrial'), ('industrial','en','Industrial'), ('industrial','de','Industrie'),
  ('agro','ro','Agricultură'), ('agro','en','Agriculture'), ('agro','de','Landwirtschaft'),
  ('medical/devices','ro','Dispozitive'), ('medical/devices','en','Devices'), ('medical/devices','de','Geräte'),
  ('medical/consumables','ro','Consumabile'), ('medical/consumables','en','Consumables'), ('medical/consumables','de','Verbrauchsmaterial'),
  ('medical/mobility','ro','Mobilitate'), ('medical/mobility','en','Mobility'), ('medical/mobility','de','Mobilität'),
  ('medical/dental','ro','Stomatologie'), ('medical/dental','en','Dental'), ('medical/dental','de','Dental'),
  ('medical/lab','ro','Laborator'), ('medical/lab','en','Lab'), ('medical/lab','de','Labor'),
  ('medical/orthopedic','ro','Ortopedie'), ('medical/orthopedic','en','Orthopedic'), ('medical/orthopedic','de','Orthopädie'),
  ('industrial/machines','ro','Utilaje'), ('industrial/machines','en','Machinery'), ('industrial/machines','de','Maschinen'),
  ('industrial/packaging','ro','Ambalaje'), ('industrial/packaging','en','Packaging'), ('industrial/packaging','de','Verpackung'),
  ('industrial/safety','ro','Protecția muncii'), ('industrial/safety','en','Safety'), ('industrial/safety','de','Arbeitsschutz'),
  ('industrial/horeca','ro','HoReCa'), ('industrial/horeca','en','HoReCa'), ('industrial/horeca','de','HoReCa'),
  ('agro/tractors','ro','Tractoare'), ('agro/tractors','en','Tractors'), ('agro/tractors','de','Traktoren'),
  ('agro/seeds','ro','Semințe'), ('agro/seeds','en','Seeds'), ('agro/seeds','de','Saatgut'),
  ('agro/livestock','ro','Zootehnie'), ('agro/livestock','en','Livestock'), ('agro/livestock','de','Viehzucht'),
  ('agro/irrigation','ro','Irigații'), ('agro/irrigation','en','Irrigation'), ('agro/irrigation','de','Bewässerung')
ON CONFLICT DO NOTHING;
