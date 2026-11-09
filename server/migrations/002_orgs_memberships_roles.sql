-- 002: firm workspaces, roles, memberships and invites (F0.1).
--
-- `users` is defined in .projexlight/schemas/user-defined-schemas.sql and is owned by
-- the ProjexLight schema export, so it is NOT altered here (MUSTNOT-04). Account
-- attributes the app needs beyond id/email/password_hash live in user_profiles,
-- one row per user, which also carries the case-insensitive unique email.
--
-- Every tenant-scoped table carries org_id and an index that leads with it.
-- Row-level security policies on these tables are added by task F8.1.

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email          CITEXT NOT NULL,
  full_name      VARCHAR(200) NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'disabled')),
  email_verified_at TIMESTAMPTZ,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One account per email address, regardless of case.
CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_email_uq ON user_profiles (email);

CREATE TABLE IF NOT EXISTS orgs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(200) NOT NULL CHECK (length(btrim(name)) > 0),
  slug        CITEXT NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended')),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS orgs_slug_uq ON orgs (slug);

-- Built-in roles have org_id NULL and are shared by every firm; custom roles (F10.2)
-- belong to one org. `key` is the stable identifier code checks against.
CREATE TABLE IF NOT EXISTS roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES orgs(id) ON DELETE CASCADE,
  key         VARCHAR(50) NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,49}$'),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  is_builtin  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (is_builtin = (org_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_builtin_key_uq ON roles (key) WHERE org_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS roles_org_key_uq ON roles (org_id, key) WHERE org_id IS NOT NULL;

INSERT INTO roles (org_id, key, name, description, is_builtin) VALUES
  (NULL, 'owner',    'Owner',    'Full control of the firm, billing and ownership transfer', true),
  (NULL, 'admin',    'Admin',    'Manages users, roles, settings and all client workspaces', true),
  (NULL, 'editor',   'Editor',   'Works on client projects: connects folders, resolves problems, drafts', true),
  (NULL, 'reviewer', 'Reviewer', 'Reviews and approves drafts and findings', true),
  (NULL, 'viewer',   'Viewer',   'Read-only access to assigned client workspaces', true)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS memberships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  status      VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'deactivated')),
  invited_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_org_user_uq ON memberships (org_id, user_id);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);

-- An invite stores only a hash of its token; the raw token exists only in the email link.
CREATE TABLE IF NOT EXISTS invites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email        CITEXT NOT NULL,
  role_id      UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  token_hash   CHAR(64) NOT NULL,
  invited_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  accepted_at  TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS invites_token_hash_uq ON invites (token_hash);
CREATE INDEX IF NOT EXISTS invites_org_created_idx ON invites (org_id, created_at DESC);
-- At most one open invite per email per firm.
CREATE UNIQUE INDEX IF NOT EXISTS invites_open_email_uq
  ON invites (org_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
