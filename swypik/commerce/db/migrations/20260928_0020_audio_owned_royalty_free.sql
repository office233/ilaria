-- Migration: sunete proprii Swypik și piese royalty-free cu licență comercială.
--
-- Biblioteca de sunete pentru reels (/api/audio/tracks, AudioPicker) arată doar
-- piese `is_active AND licensed_for_commercial` (platformă monetizată). În
-- producție nu exista niciuna, deci „Adaugă sunet” era mereu gol. Pe lângă
-- catalogul artiștilor ('swypik-artist') și CC0 / CC BY / CC BY-SA, acceptăm:
--
--   'swypik-owned'             — sunete create/comandate de Swypik (drepturi integrale);
--   'royalty-free-commercial'  — piese cumpărate cu licență royalty-free care permite
--                                explicit uz comercial ȘI sincronizare pe video.
--
-- Aceeași regulă ca lib/audio/license.ts (isCommercialLicense). Cum se adaugă o
-- piesă: docs/audio/sound-library.md. Aditivă și idempotentă.

UPDATE audio_tracks
   SET licensed_for_commercial = true,
       updated_at = NOW()
 WHERE licensed_for_commercial = false
   AND license IS NOT NULL
   AND lower(trim(license)) IN ('swypik-owned', 'royalty-free-commercial');
