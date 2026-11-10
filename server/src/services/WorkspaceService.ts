import { AppError, ErrorCodes } from '../utils/AppError';
import { decodeCursor, Page, pageSize, toPage } from '../utils/pagination';
import { dataService, Tx } from './DataService';

/** Firm context of the signed-in user: every query below is scoped to orgId. */
export interface Ctx {
  orgId: string;
  userId: string;
}

export interface ClientView {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

export interface DeviceView {
  id: string;
  clientId: string;
  name: string;
  modelNames: string[];
  udiDi: string | null;
  productCode: string | null;
  deviceClass: string | null;
  createdAt: string;
}

export interface ProjectView {
  id: string;
  clientId: string;
  deviceId: string;
  name: string;
  submissionType: string;
  status: string;
  targetDate: string | null;
  createdAt: string;
  updatedAt: string;
}

type ClientRow = { id: string; name: string; status: string; created_at: Date };
type DeviceRow = {
  id: string;
  workspace_id: string;
  name: string;
  model_names: string[];
  udi_di: string | null;
  product_code: string | null;
  device_class: string | null;
  created_at: Date;
};
type ProjectRow = {
  id: string;
  workspace_id: string;
  device_id: string;
  name: string;
  submission_type: string;
  status: string;
  target_date: string | null;
  created_at: Date;
  updated_at: Date;
};

const iso = (d: Date | string): string => new Date(d).toISOString();
const toClient = (r: ClientRow): ClientView => ({ id: r.id, name: r.name, status: r.status, createdAt: iso(r.created_at) });
const toDevice = (r: DeviceRow): DeviceView => ({
  id: r.id,
  clientId: r.workspace_id,
  name: r.name,
  modelNames: r.model_names,
  udiDi: r.udi_di,
  productCode: r.product_code,
  deviceClass: r.device_class,
  createdAt: iso(r.created_at),
});
const toProject = (r: ProjectRow): ProjectView => ({
  id: r.id,
  clientId: r.workspace_id,
  deviceId: r.device_id,
  name: r.name,
  submissionType: r.submission_type,
  status: r.status,
  targetDate: r.target_date ? String(r.target_date).slice(0, 10) : null,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const DEVICE_COLS = 'id, workspace_id, name, model_names, udi_di, product_code, device_class, created_at';
const PROJECT_COLS = 'id, workspace_id, device_id, name, submission_type, status, target_date::text AS target_date, created_at, updated_at';

/** Map unique-index violations to the API's conflict codes; rethrow anything else. */
function conflict(err: unknown): never {
  const constraint = (err as { constraint?: string }).constraint;
  if (constraint === 'client_workspaces_org_name_uq') {
    throw new AppError(409, ErrorCodes.DUPLICATE_NAME, 'A client with this name already exists');
  }
  if (constraint === 'devices_workspace_name_uq') {
    throw new AppError(409, ErrorCodes.DUPLICATE_NAME, 'This client already has a device with this name');
  }
  if (constraint === 'devices_org_udi_di_uq') {
    throw new AppError(409, ErrorCodes.DUPLICATE_UDI_DI, 'Another device in your firm already has this UDI-DI');
  }
  throw err;
}

function notFound(what: string): AppError {
  return new AppError(404, ErrorCodes.NOT_FOUND, `${what} not found`);
}

/** Run a write; a unique violation inside is reported as 409 without aborting other work. */
async function guarded<T>(tx: Tx, table: Parameters<Tx['query']>[0], work: () => Promise<T>): Promise<T> {
  await tx.query(table, 'SAVEPOINT guarded_write');
  try {
    return await work();
  } catch (err) {
    await tx.query(table, 'ROLLBACK TO SAVEPOINT guarded_write');
    return conflict(err);
  }
}

export class WorkspaceService {
  // --- clients ------------------------------------------------------------------------

  async listClients(ctx: Ctx, opts: { limit?: number; cursor?: string; status?: string }): Promise<Page<ClientView>> {
    const size = pageSize(opts.limit);
    const after = decodeCursor(opts.cursor);
    const rows = await dataService.query<ClientRow>(
      ctx,
      'client_workspaces',
      `SELECT id, name, status, created_at FROM client_workspaces
        WHERE org_id = $1 AND ($2::text IS NULL OR status = $2)
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $5`,
      [ctx.orgId, opts.status ?? null, after.createdAt, after.id, size + 1]
    );
    return toPage(rows, size, toClient);
  }

  async createClient(ctx: Ctx, input: { name: string }): Promise<ClientView> {
    return dataService.transaction(ctx, (tx) =>
      guarded(tx, 'client_workspaces', async () => {
        const [row] = await tx.query<ClientRow>(
          'client_workspaces',
          `INSERT INTO client_workspaces (org_id, name, created_by) VALUES ($1, $2, $3)
           RETURNING id, name, status, created_at`,
          [ctx.orgId, input.name, ctx.userId]
        );
        return toClient(row);
      })
    );
  }

  async updateClient(ctx: Ctx, clientId: string, input: { name?: string; status?: string }): Promise<ClientView> {
    return dataService.transaction(ctx, (tx) =>
      guarded(tx, 'client_workspaces', async () => {
        const [row] = await tx.query<ClientRow>(
          'client_workspaces',
          `UPDATE client_workspaces SET name = COALESCE($3, name), status = COALESCE($4, status), updated_at = now()
            WHERE id = $1 AND org_id = $2 RETURNING id, name, status, created_at`,
          [clientId, ctx.orgId, input.name ?? null, input.status ?? null]
        );
        if (!row) {
          throw notFound('Client');
        }
        return toClient(row);
      })
    );
  }

  // --- devices ------------------------------------------------------------------------

  async listDevices(ctx: Ctx, clientId: string, opts: { limit?: number; cursor?: string }): Promise<Page<DeviceView>> {
    const size = pageSize(opts.limit);
    const after = decodeCursor(opts.cursor);
    await this.requireClient(ctx, clientId);
    const rows = await dataService.query<DeviceRow>(
      ctx,
      'devices',
      `SELECT ${DEVICE_COLS} FROM devices
        WHERE org_id = $1 AND workspace_id = $2
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $5`,
      [ctx.orgId, clientId, after.createdAt, after.id, size + 1]
    );
    return toPage(rows, size, toDevice);
  }

  async createDevice(
    ctx: Ctx,
    clientId: string,
    input: { name: string; modelNames: string[]; udiDi?: string | null; productCode?: string | null; deviceClass?: string | null }
  ): Promise<DeviceView> {
    return dataService.transaction(ctx, async (tx) => {
      await this.requireClient(ctx, clientId, tx);
      return guarded(tx, 'devices', async () => {
        const [row] = await tx.query<DeviceRow>(
          'devices',
          `INSERT INTO devices (org_id, workspace_id, name, model_names, udi_di, product_code, device_class, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${DEVICE_COLS}`,
          [ctx.orgId, clientId, input.name, input.modelNames, input.udiDi ?? null, input.productCode ?? null, input.deviceClass ?? null, ctx.userId]
        );
        return toDevice(row);
      });
    });
  }

  async updateDevice(
    ctx: Ctx,
    deviceId: string,
    input: { name?: string; modelNames?: string[]; udiDi?: string | null; productCode?: string | null; deviceClass?: string | null }
  ): Promise<DeviceView> {
    // A null in the input clears an optional field; an absent key leaves it unchanged.
    const set = (key: keyof typeof input): boolean => Object.prototype.hasOwnProperty.call(input, key);
    return dataService.transaction(ctx, (tx) =>
      guarded(tx, 'devices', async () => {
        const [row] = await tx.query<DeviceRow>(
          'devices',
          `UPDATE devices SET
              name = COALESCE($3, name),
              model_names = COALESCE($4, model_names),
              udi_di = CASE WHEN $5 THEN $6 ELSE udi_di END,
              product_code = CASE WHEN $7 THEN $8 ELSE product_code END,
              device_class = CASE WHEN $9 THEN $10 ELSE device_class END,
              updated_at = now()
            WHERE id = $1 AND org_id = $2 RETURNING ${DEVICE_COLS}`,
          [
            deviceId,
            ctx.orgId,
            input.name ?? null,
            input.modelNames ?? null,
            set('udiDi'),
            input.udiDi ?? null,
            set('productCode'),
            input.productCode ?? null,
            set('deviceClass'),
            input.deviceClass ?? null,
          ]
        );
        if (!row) {
          throw notFound('Device');
        }
        return toDevice(row);
      })
    );
  }

  // --- projects -----------------------------------------------------------------------

  async listProjects(ctx: Ctx, clientId: string, opts: { limit?: number; cursor?: string; status?: string }): Promise<Page<ProjectView>> {
    const size = pageSize(opts.limit);
    const after = decodeCursor(opts.cursor);
    await this.requireClient(ctx, clientId);
    const rows = await dataService.query<ProjectRow>(
      ctx,
      'projects',
      `SELECT ${PROJECT_COLS} FROM projects
        WHERE org_id = $1 AND workspace_id = $2 AND ($3::text IS NULL OR status = $3)
          AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $6`,
      [ctx.orgId, clientId, opts.status ?? null, after.createdAt, after.id, size + 1]
    );
    return toPage(rows, size, toProject);
  }

  async createProject(
    ctx: Ctx,
    deviceId: string,
    input: { name: string; submissionType: string; targetDate?: string | null }
  ): Promise<ProjectView> {
    return dataService.transaction(ctx, async (tx) => {
      const devices = await tx.query<{ workspace_id: string }>('devices', 'SELECT workspace_id FROM devices WHERE id = $1 AND org_id = $2', [
        deviceId,
        ctx.orgId,
      ]);
      if (!devices[0]) {
        throw notFound('Device');
      }
      const [row] = await tx.query<ProjectRow>(
        'projects',
        `INSERT INTO projects (org_id, workspace_id, device_id, name, submission_type, target_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${PROJECT_COLS}`,
        [ctx.orgId, devices[0].workspace_id, deviceId, input.name, input.submissionType, input.targetDate ?? null, ctx.userId]
      );
      return toProject(row);
    });
  }

  async getProject(ctx: Ctx, projectId: string): Promise<ProjectView & { client: ClientView; device: DeviceView }> {
    const rows = await dataService.query<ProjectRow & { c_name: string; c_status: string; c_created_at: Date } & { d: DeviceRow }>(
      ctx,
      'projects',
      `SELECT p.id, p.workspace_id, p.device_id, p.name, p.submission_type, p.status, p.target_date::text AS target_date,
              p.created_at, p.updated_at,
              c.name AS c_name, c.status AS c_status, c.created_at AS c_created_at,
              row_to_json(d.*) AS d
         FROM projects p
         JOIN client_workspaces c ON c.id = p.workspace_id AND c.org_id = p.org_id
         JOIN devices d ON d.id = p.device_id AND d.org_id = p.org_id
        WHERE p.id = $1 AND p.org_id = $2`,
      [projectId, ctx.orgId]
    );
    const r = rows[0];
    if (!r) {
      throw notFound('Project');
    }
    return {
      ...toProject(r),
      client: toClient({ id: r.workspace_id, name: r.c_name, status: r.c_status, created_at: r.c_created_at }),
      device: toDevice(r.d),
    };
  }

  async updateProject(ctx: Ctx, projectId: string, input: { name?: string; status?: string; targetDate?: string | null }): Promise<ProjectView> {
    const clearDate = Object.prototype.hasOwnProperty.call(input, 'targetDate');
    const [row] = await dataService.query<ProjectRow>(
      ctx,
      'projects',
      `UPDATE projects SET name = COALESCE($3, name), status = COALESCE($4, status),
              target_date = CASE WHEN $5 THEN $6::date ELSE target_date END, updated_at = now()
        WHERE id = $1 AND org_id = $2 RETURNING ${PROJECT_COLS}`,
      [projectId, ctx.orgId, input.name ?? null, input.status ?? null, clearDate, input.targetDate ?? null]
    );
    if (!row) {
      throw notFound('Project');
    }
    return toProject(row);
  }

  private async requireClient(ctx: Ctx, clientId: string, tx?: Tx): Promise<void> {
    const sql = 'SELECT 1 FROM client_workspaces WHERE id = $1 AND org_id = $2';
    const rows = tx ? await tx.query('client_workspaces', sql, [clientId, ctx.orgId]) : await dataService.query(ctx, 'client_workspaces', sql, [clientId, ctx.orgId]);
    if (!rows[0]) {
      throw notFound('Client');
    }
  }
}

export const workspaceService = new WorkspaceService();
