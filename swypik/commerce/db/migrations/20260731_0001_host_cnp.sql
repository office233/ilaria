-- CNP gazde (DAC7 / raportare ANAF) — stocat DOAR criptat.
--   cnp_encrypted: AES-256-GCM (iv:tag:ciphertext, hex) — nu se afișează în UI
--   cnp_hash:      SHA-256 cu pepper — detectare duplicate fără decriptare
ALTER TABLE host_applications ADD COLUMN IF NOT EXISTS cnp_encrypted TEXT;
ALTER TABLE host_applications ADD COLUMN IF NOT EXISTS cnp_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_host_apps_cnp_hash ON host_applications (cnp_hash) WHERE cnp_hash IS NOT NULL;
