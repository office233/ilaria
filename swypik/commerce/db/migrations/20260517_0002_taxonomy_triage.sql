-- Manual taxonomy triage for the 24 remaining `taxonomy_unresolved=true` rows
-- produced by the i18n seeder. Applied on prod 2026-05-17.
-- Maps each product to a leaf/category slug and clears the unresolved flag.
-- Also bumps `is_adult=true` for items the new word-boundary detector now catches
-- but were imported earlier under the naive substring detector.

BEGIN;

UPDATE marketplace_products SET
  taxonomy_node_slug = 'beauty-fragrance',
  taxonomy_reason = 'manual_triage',
  taxonomy_confidence = 0.95,
  taxonomy_unresolved = false,
  updated_at = NOW()
WHERE id = 'c702133c-a56b-4e9a-b9cb-ec38e7bcac78';

UPDATE marketplace_products SET
  taxonomy_node_slug = 'beauty-skincare',
  taxonomy_reason = 'manual_triage', taxonomy_confidence = 0.95, taxonomy_unresolved = false, updated_at = NOW()
WHERE id IN (
  '1935afef-ea20-4001-8658-120115047bbe',
  'a2415ba1-72a4-4b23-b9f8-e6d8e282bd6e'
);

UPDATE marketplace_products SET
  taxonomy_node_slug = 'health-personal',
  taxonomy_reason = 'manual_triage', taxonomy_confidence = 0.95, taxonomy_unresolved = false, updated_at = NOW()
WHERE id IN (
  '926be892-8064-4f24-9870-6788880cc524',
  '04d8815b-0e62-4238-9ec2-c7d85f5569b9',
  'e3d3f2bc-75a9-47c2-873c-b663740411c5',
  '709222c0-b51c-46db-999b-a0dca834350b',
  'b5fcf985-cadf-47dc-b5d9-9abc67126bdc',
  '1ed841a2-7605-47e7-b5f0-820cb38bbf9d',
  'a7f82c72-6785-4260-a1aa-5daca06c4b97'
);

UPDATE marketplace_products SET
  taxonomy_node_slug = 'beauty-makeup-eyes',
  taxonomy_reason = 'manual_triage', taxonomy_confidence = 0.95, taxonomy_unresolved = false, updated_at = NOW()
WHERE id IN (
  'd6f41843-89a2-4818-ba5c-7865c6143ff8',
  'b6fcad6e-226b-47f3-8891-885f229ff1bc'
);

UPDATE marketplace_products SET
  taxonomy_node_slug = 'beauty-makeup-face',
  taxonomy_reason = 'manual_triage', taxonomy_confidence = 0.95, taxonomy_unresolved = false, updated_at = NOW()
WHERE id IN (
  'a7b32aa4-b38b-40b1-b53c-99d3fa567fac',
  '00b3cad7-d32e-46b4-b5cb-b069f08ef3c2'
);

UPDATE marketplace_products SET
  taxonomy_node_slug = 'beauty-makeup-lips',
  taxonomy_reason = 'manual_triage', taxonomy_confidence = 0.95, taxonomy_unresolved = false, updated_at = NOW()
WHERE id = '2cb1f81f-e7a2-4ec1-bef2-e28ea5d9594b';

UPDATE marketplace_products SET
  taxonomy_node_slug = 'beauty-haircare',
  taxonomy_reason = 'manual_triage', taxonomy_confidence = 0.95, taxonomy_unresolved = false, updated_at = NOW()
WHERE id IN (
  '1961318f-0335-44b5-a9f0-c78514b89618',
  'eb4d3915-fb34-428e-926c-a3ef0d3da6e8'
);

UPDATE marketplace_products SET
  taxonomy_node_slug = 'beauty-hair-styling',
  taxonomy_reason = 'manual_triage', taxonomy_confidence = 0.95, taxonomy_unresolved = false, updated_at = NOW()
WHERE id = 'ecce6fa3-171e-4453-ae36-83afb21fb1ed';

UPDATE marketplace_products SET
  taxonomy_node_slug = 'fashion-women-dresses',
  taxonomy_reason = 'manual_triage', taxonomy_confidence = 0.95, taxonomy_unresolved = false, updated_at = NOW()
WHERE id IN (
  '40f24042-c34c-4b36-8640-8e89ccab9a0b',
  '0ed6e6f6-032d-4cf9-a77e-f69923ea4f7a'
);

UPDATE marketplace_products SET
  taxonomy_node_slug = 'toys-games',
  taxonomy_reason = 'manual_triage', taxonomy_confidence = 0.95, taxonomy_unresolved = false, updated_at = NOW()
WHERE id = '358e8425-42dc-49d1-ab09-6e79187f1df0';

-- Adult triage
UPDATE marketplace_products SET
  taxonomy_node_slug = 'beauty-fragrance',
  taxonomy_reason = 'manual_triage_adult', taxonomy_confidence = 0.95, taxonomy_unresolved = false,
  is_adult = true, adult_reason = COALESCE(adult_reason, 'manual: erotic perfume'),
  updated_at = NOW()
WHERE id = '7e125fb7-435f-4029-8ace-c2fecd32460d';

UPDATE marketplace_products SET
  taxonomy_node_slug = 'health-personal',
  taxonomy_reason = 'manual_triage_adult', taxonomy_confidence = 0.95, taxonomy_unresolved = false,
  is_adult = true, adult_reason = COALESCE(adult_reason, 'manual: bondage chastity device'),
  updated_at = NOW()
WHERE id = '93164cbe-d081-4cc0-a93a-ac21ebb7b907';

UPDATE marketplace_products SET
  taxonomy_node_slug = 'health-personal',
  taxonomy_reason = 'manual_triage_adult', taxonomy_confidence = 0.95, taxonomy_unresolved = false,
  is_adult = true, adult_reason = COALESCE(adult_reason, 'manual: sex toy vibrating egg'),
  updated_at = NOW()
WHERE id = '605a9f4c-54ba-4a25-a200-ac10149282ca';

COMMIT;
