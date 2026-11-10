-- F1.5 / ADR-017: the FDA corpus now lives only in the fda-data service's own
-- database (fda_db). Before this migration its data was copied there and checked
-- (row counts and the 510(k) key set identical). The customer database keeps no
-- FDA tables from here on; the app reads FDA data through @medexregai/fda-sdk.
DROP TABLE IF EXISTS fda_510k;
DROP TABLE IF EXISTS fda_classification;
DROP TABLE IF EXISTS fda_recall;
DROP TABLE IF EXISTS fda_udi;
DROP TABLE IF EXISTS fda_event_counts;
DROP TABLE IF EXISTS fda_sync_runs;

-- The distinct product codes of firms' devices are app data (what the app pushes to
-- fda-data with PUT /v1/tracked-product-codes), not FDA data: rename the view.
ALTER VIEW IF EXISTS fda_tracked_product_codes RENAME TO device_product_codes;
