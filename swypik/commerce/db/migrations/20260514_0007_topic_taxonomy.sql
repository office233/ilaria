-- 20260514_0007_topic_taxonomy.sql
-- Adds a small topic taxonomy + product_topics weighted join. Used by the
-- ranking layer (lib/feed/ranking) to bucket products into broad themes for
-- personalisation. Topics are intentionally generic; the AI categorisation
-- pipeline (lib/ai/upload-suggestions) maps free-form tags onto them.

CREATE TABLE IF NOT EXISTS public.topics (
    id          text PRIMARY KEY,
    label       text NOT NULL,
    parent_id   text REFERENCES public.topics(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.product_topics (
    product_id  text NOT NULL,
    topic_id    text NOT NULL REFERENCES public.topics(id) ON DELETE CASCADE,
    weight      real NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 10),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (product_id, topic_id)
);

CREATE INDEX IF NOT EXISTS product_topics_topic_idx ON public.product_topics (topic_id);
CREATE INDEX IF NOT EXISTS product_topics_product_idx ON public.product_topics (product_id);

INSERT INTO public.topics (id, label) VALUES
    ('fashion',       'Modă'),
    ('beauty',        'Frumusețe'),
    ('tech',          'Tehnologie'),
    ('home',          'Casă'),
    ('kitchen',       'Bucătărie'),
    ('fitness',       'Fitness'),
    ('kids',          'Copii'),
    ('pets',          'Animale de companie'),
    ('gaming',        'Gaming'),
    ('books',         'Cărți'),
    ('food',          'Mâncare & Băuturi'),
    ('travel',        'Călătorii'),
    ('auto',          'Auto'),
    ('garden',        'Grădină'),
    ('office',        'Birou'),
    ('jewelry',       'Bijuterii'),
    ('shoes',         'Încălțăminte'),
    ('bags',          'Genți'),
    ('accessories',   'Accesorii'),
    ('gadgets',       'Gadgets')
ON CONFLICT (id) DO NOTHING;
