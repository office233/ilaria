-- Profil oficial Swypik: user creator verificat (bifă) + creator_profile verificat.
-- Idempotent — poate fi rulat de mai multe ori.
BEGIN;

INSERT INTO users (id, username, display_name, email, role, is_verified, bio, avatar_url)
VALUES (
  '00000000-0000-4000-9000-0000000f1c1a',
  'swypik',
  'Swypik',
  'oficial@swypik.com',
  'creator',
  true,
  'Contul oficial Swypik ✈️ Descoperă destinații spectaculoase și rezervă direct din video.',
  'https://swypik.com/icon-512.png'
)
ON CONFLICT ((lower(username))) DO UPDATE
SET role = 'creator', is_verified = true, display_name = 'Swypik';

INSERT INTO creator_profiles (user_id, handle, display_name, bio, avatar_url, category, website_url, verification_status, social_links)
SELECT u.id, 'swypik', 'Swypik',
  'Contul oficial Swypik ✈️ Destinații spectaculoase, rezervi direct din video.',
  'https://swypik.com/icon-512.png',
  'travel', 'https://swypik.com', 'verified',
  '{"website":"https://swypik.com"}'::jsonb
FROM users u WHERE u.username = 'swypik'
ON CONFLICT (user_id) DO UPDATE SET verification_status = 'verified';

SELECT u.id AS user_id, u.username, u.is_verified, cp.id AS profile_id, cp.verification_status
FROM users u JOIN creator_profiles cp ON cp.user_id = u.id
WHERE u.username = 'swypik';

COMMIT;
