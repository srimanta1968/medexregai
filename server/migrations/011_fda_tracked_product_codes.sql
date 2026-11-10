-- F1.1 Which product codes the MAUDE count sync follows: those on any firm's device.
-- Exposes only distinct 3-letter FDA product codes (public identifiers), never the
-- firm, client or device, so the platform-level sync can read it without a tenant.
CREATE OR REPLACE VIEW fda_tracked_product_codes AS
  SELECT DISTINCT upper(product_code)::varchar(3) AS product_code
    FROM devices
   WHERE product_code IS NOT NULL;
