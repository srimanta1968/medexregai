-- fda_db 003: tracked product codes are kept per API client, so one client replacing
-- its own list (PUT /v1/tracked-product-codes) never drops codes another client tracks.
ALTER TABLE tracked_product_codes DROP CONSTRAINT tracked_product_codes_pkey;
ALTER TABLE tracked_product_codes ADD PRIMARY KEY (product_code, source_client);
CREATE INDEX IF NOT EXISTS tracked_product_codes_client_idx ON tracked_product_codes (source_client);
