ALTER TABLE app_webhook_deliveries ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 1;
