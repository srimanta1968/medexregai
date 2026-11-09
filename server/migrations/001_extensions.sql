-- 001: extensions used across the schema.
-- pgcrypto: gen_random_uuid(); citext: case-insensitive emails and slugs.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
