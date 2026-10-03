-- Migration: flag „licențiat pentru uz comercial" pe biblioteca de sunete.
--
-- Swypik e o platformă monetizată (deblocări, reclame, comerț), deci în reels
-- și în feed intră doar piese cu licență care permite uz comercial ȘI
-- sincronizare pe video: catalogul propriu al artiștilor ('swypik-artist'),
-- domeniu public / CC0, CC BY, CC BY-SA. NC (necomercial) și ND (fără opere
-- derivate — sincronizarea pe video e adaptare) rămân excluse. Aceeași regulă
-- ca lib/audio/license.ts (isCommercialLicense). Aditivă și idempotentă.

ALTER TABLE audio_tracks
    ADD COLUMN IF NOT EXISTS licensed_for_commercial boolean NOT NULL DEFAULT false;

UPDATE audio_tracks
   SET licensed_for_commercial = true
 WHERE licensed_for_commercial = false
   AND license IS NOT NULL
   AND (
        lower(license) IN ('swypik-artist', 'cc0', 'public-domain', 'publicdomain', 'cc-by', 'cc-by-sa')
        OR lower(license) ~ 'creativecommons\.org/(publicdomain/zero|licenses/by/|licenses/by-sa/)'
   )
   AND lower(license) !~ '(-nc|/by-nc|-nd|/by-nd)';

CREATE INDEX IF NOT EXISTS idx_audio_tracks_commercial
    ON audio_tracks (popularity DESC) WHERE is_active = true AND licensed_for_commercial = true;
