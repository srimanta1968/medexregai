-- F6.2: when each opted-in firm was last offered an introduction, so routing spreads offers
-- across matching firms (longest-waiting first) without reading other firms' tenant rows.
ALTER TABLE firm_intro_settings ADD COLUMN IF NOT EXISTS last_offered_at timestamptz;
CREATE INDEX IF NOT EXISTS firm_intro_settings_route_idx ON firm_intro_settings (last_offered_at NULLS FIRST) WHERE opted_in;
