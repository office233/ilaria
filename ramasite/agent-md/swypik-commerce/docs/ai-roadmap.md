# AI Roadmap — Swypik

## Foundation (2026-05-15)
- ✅ **pgvector embeddings** — migrație `20260515_0024_ai_embeddings.sql` pe `marketplace_products` + `videos` (coloane `embedding vector(1536)`, `embedding_updated_at`, index `ivfflat cosine`). NECESITĂ upgrade imagine Postgres la `pgvector/pgvector:pg16` — vezi `docs/pgvector-upgrade.md`. Migrația e idempotentă, va fi aplicată automat la prima rulare după upgrade.
- ✅ **Embedding helper** — `lib/ai/embeddings.ts` apelează GitHub Models `text-embedding-3-small` (1536 dim).
- ✅ **Cron backfill** — `app/api/cron/embed-batch/route.ts` rulează la `*/15 min`, procesează 50 produse + 50 video per tick. Skip silent dacă coloana `embedding` nu există (pre-upgrade).
- ✅ **AI Product Match** — `GET /api/products/similar?product_id=X` sau `?text=query`. Cosine similarity (`embedding <=> $1::vector`). Folosit în `app/product/[id]/ProductClient.tsx` secțiunea "Produse similare" (UI integration pending).
- ✅ **AI Content Moderation (text)** — `lib/ai/moderate.ts` cu `openai/gpt-4o-mini` JSON mode. Integrare în creator upload pipeline TODO.

## În lucru / planificat
- 🔄 **AI Visual Search (CLIP)** — stub pagina `/visual-search` + endpoint 501. Necesită serviciu separat (Replicate `cjwbw/clip-vit-large-patch14` sau fal.ai). Cost estimat: ~$0.0004/imagine. Pipeline:
  1. Upload imagine în R2 (presigned URL existent).
  2. Call Replicate/fal cu URL imagine → embedding 768 sau 512 dim CLIP.
  3. Match contra coloanei `marketplace_products.image_embedding` (necesită migrație + backfill cron separat — embed-images-batch).
- 🔄 **AI Translation captions (Whisper)** — pipeline video pe video-worker. Whisper local (whisper.cpp) sau Replicate. Captions multilingv salvate în `videos.captions_jsonb`.
- 🔄 **AI Voice Shopping (Whisper STT)** — buton 🎙️ în SearchBar → Whisper API → text query → `/api/search`. UI există parțial.
- 🔄 **AI Try-On (Replicate)** — endpoint dedicat, model `cjwbw/idm-vton` sau `falai/cat-vton`. UI placeholder pe product page „Încearcă pe tine”.
- 🔄 **AI Trend Detection** — cron analyzer pe `swypik_view_events` + `searches`. Cluster embeddings de video populare ultimele 24h. Output: `trending_topics` table.
- 🔄 **AI Creator Assistant** — multi-call GitHub Models: hashtag suggest (există) + thumbnail suggest + best-time-to-post + script outline.

## Conventii
- **Toate apelurile AI** trec prin GitHub Models (`GITHUB_TOKEN`). NU folosim OpenRouter, NU OpenAI direct.
- **Moderation never blocks** — defaults `flagged=false` la orice eroare provider.
- **Cron auth** — Bearer `CRON_SECRET` (`timingSafeEqual`).
- **Embedding model** — `openai/text-embedding-3-small` (1536). Pentru text > 8000 chars, slice la 8000.
