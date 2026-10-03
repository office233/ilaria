-- e-Factura (CIUS-RO): factura are nevoie de adresa structurată a clientului
-- (stradă, oraș, județ ISO, țară) și de datele furnizorului din momentul emiterii.
--  * client_details    — adresa structurată a clientului (jsonb)
--  * supplier_snapshot — profilul fiscal al sellerului la emitere (jsonb); NULL pentru
--                        facturile vechi (se folosește profilul curent)
-- Idempotent, doar coloane noi (nimic șters).
ALTER TABLE seller_invoices ADD COLUMN IF NOT EXISTS client_details jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE seller_invoices ADD COLUMN IF NOT EXISTS supplier_snapshot jsonb;
