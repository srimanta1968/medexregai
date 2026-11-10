-- F0.2 Org > client workspace > device > project (Architecture v2.0 §7, §18).
-- Every row carries org_id (tenant) and, below the workspace, workspace_id, so the
-- row-level security policies of F8.1 can filter on both. Composite foreign keys
-- (child.parent_id, child.org_id) -> parent(id, org_id) make it impossible for a
-- row to reference a parent in another firm, even through a bug in the app.

-- A consultancy's client (the manufacturer whose device is being submitted).
CREATE TABLE IF NOT EXISTS client_workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        varchar(200) NOT NULL,
  status      varchar(16) NOT NULL DEFAULT 'active',
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_workspaces_status_chk CHECK (status IN ('active', 'archived')),
  CONSTRAINT client_workspaces_id_org_uq UNIQUE (id, org_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS client_workspaces_org_name_uq ON client_workspaces (org_id, lower(name));
-- Cursor pagination: newest first within a firm.
CREATE INDEX IF NOT EXISTS client_workspaces_org_created_idx ON client_workspaces (org_id, created_at DESC, id DESC);

-- A device has one stable identity (this id never changes) so tests, suppliers,
-- clearances and field data can link to it later. UDI-DI is optional until known.
CREATE TABLE IF NOT EXISTS devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  workspace_id  uuid NOT NULL,
  name          varchar(200) NOT NULL,
  model_names   text[] NOT NULL DEFAULT '{}',
  udi_di        varchar(23),
  product_code  char(3),
  device_class  varchar(3),
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_workspace_fk FOREIGN KEY (workspace_id, org_id)
    REFERENCES client_workspaces (id, org_id) ON DELETE CASCADE,
  CONSTRAINT devices_id_org_uq UNIQUE (id, org_id),
  CONSTRAINT devices_class_chk CHECK (device_class IS NULL OR device_class IN ('I', 'II', 'III')),
  CONSTRAINT devices_product_code_chk CHECK (product_code IS NULL OR product_code ~ '^[A-Z]{3}$'),
  CONSTRAINT devices_udi_di_chk CHECK (udi_di IS NULL OR udi_di ~ '^[A-Za-z0-9+$/.\-]{6,23}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS devices_workspace_name_uq ON devices (workspace_id, lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS devices_org_udi_di_uq ON devices (org_id, udi_di) WHERE udi_di IS NOT NULL;
CREATE INDEX IF NOT EXISTS devices_workspace_created_idx ON devices (org_id, workspace_id, created_at DESC, id DESC);

-- A submission project for one device (DeviceProject in the architecture).
CREATE TABLE IF NOT EXISTS projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  workspace_id     uuid NOT NULL,
  device_id        uuid NOT NULL,
  name             varchar(200) NOT NULL,
  submission_type  varchar(16) NOT NULL DEFAULT 'traditional',
  status           varchar(16) NOT NULL DEFAULT 'active',
  target_date      date,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_workspace_fk FOREIGN KEY (workspace_id, org_id)
    REFERENCES client_workspaces (id, org_id) ON DELETE CASCADE,
  CONSTRAINT projects_device_fk FOREIGN KEY (device_id, org_id)
    REFERENCES devices (id, org_id) ON DELETE CASCADE,
  CONSTRAINT projects_type_chk CHECK (submission_type IN ('traditional', 'special', 'abbreviated')),
  CONSTRAINT projects_status_chk CHECK (status IN ('active', 'submitted', 'cleared', 'archived'))
);
CREATE INDEX IF NOT EXISTS projects_workspace_created_idx ON projects (org_id, workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS projects_device_idx ON projects (device_id);
-- "My recent projects" across workspaces.
CREATE INDEX IF NOT EXISTS projects_org_updated_idx ON projects (org_id, updated_at DESC, id DESC);
