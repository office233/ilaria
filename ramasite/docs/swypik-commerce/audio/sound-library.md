# Biblioteca de sunete pentru reels

„Adaugă sunet” din wizardul de upload (`components/reels/AudioPicker.tsx`) listează doar
piesele din `audio_tracks` cu `is_active = true AND licensed_for_commercial = true`
(`GET /api/audio/tracks`). Swypik e monetizat (reclame, deblocări, comerț), deci o piesă
intră în reels numai cu o licență care permite **uz comercial și sincronizare pe video**.
Piesa aleasă e mixată de workerul video (ffmpeg `amix`, `workers/video-worker/video_worker/sound_mix.py`):
volum, păstrează / înlocuiește audio-ul original, buclă, momentul de start al piesei.

## Licențe acceptate (`lib/audio/license.ts`)

| `license` | Când |
|---|---|
| `swypik-artist` | Piese publicate de artiști în Swypik Music (sincronizate automat de `lib/music/publish.ts`) |
| `swypik-owned` | Sunete create sau comandate de Swypik, cu drepturi integrale (contract/cesiune la dosar) |
| `royalty-free-commercial` | Piese cumpărate cu licență royalty-free care permite explicit uz comercial ȘI sync pe video |
| `cc0`, `public-domain`, `cc-by`, `cc-by-sa` (sau URL-ul creativecommons.org) | Licențe deschise compatibile; CC BY cere atribuire (`attribution_url`) |

NC (necomercial) și ND (fără opere derivate) sunt respinse. O licență necunoscută = respinsă.

## Cum adaugi o piesă proprie / royalty-free

1. Păstrează dovada licenței (factură, contract, pagina licenței) în dosarul juridic.
2. Urcă fișierul (MP3/AAC, ideal ≤ 10 MB) în bucket-ul public de media R2, de ex.
   `audio/library/<slug>.mp3`; URL-ul public trebuie să fie **https**.
3. Pe nodul `data` (vezi CLAUDE.md, „Conectare DB”), inserează rândul:

```sql
INSERT INTO audio_tracks (source, source_id, title, artist, duration_s, audio_url, image_url,
                          genre, tags, license, attribution_url, licensed_for_commercial, is_active)
VALUES ('swypik', 'summer-intro-01', 'Summer Intro', 'Swypik Sounds', 30,
        'https://<media-public-host>/audio/library/summer-intro-01.mp3', NULL,
        'pop', ARRAY['summer','upbeat'], 'swypik-owned', NULL, true, true)
ON CONFLICT (source, source_id) DO UPDATE
   SET audio_url = EXCLUDED.audio_url, license = EXCLUDED.license,
       licensed_for_commercial = EXCLUDED.licensed_for_commercial, is_active = true, updated_at = NOW();
```

`genre` trebuie să fie unul din genurile din picker (`pop`, `rock`, `electronic`, `hiphop`,
`jazz`, `classical`, `ambient`, `dance`) ca să apară la filtru. Scoaterea unei piese:
`UPDATE audio_tracks SET is_active = false WHERE id = …` (clipurile deja mixate rămân neschimbate).

Fără nicio piesă licențiată, pickerul arată o stare goală onestă („încă nu avem sunete
licențiate — publică cu sunetul original”), iar clipul se publică cu audio-ul lui.
