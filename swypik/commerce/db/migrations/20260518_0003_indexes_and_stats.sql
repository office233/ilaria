-- 3 FK unindexed identified by audit
CREATE INDEX IF NOT EXISTS live_polls_stream_id_idx ON live_polls(stream_id);
CREATE INDEX IF NOT EXISTS product_reviews_order_id_idx ON product_reviews(order_id);
CREATE INDEX IF NOT EXISTS review_helpful_votes_user_id_idx ON review_helpful_votes(user_id);

INSERT INTO schema_migrations(version) VALUES ('20260518_0003_indexes_and_stats')
ON CONFLICT (version) DO NOTHING;
