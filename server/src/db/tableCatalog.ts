/**
 * Every table the application may query, and how it is scoped.
 *
 * DataService refuses a table that is not listed here, so a typo or an
 * attacker-influenced table name can never reach SQL (coding standard
 * "Missing Table Catalog Validation"). Add a table here in the same change as
 * the migration that creates it.
 *
 *  - platform: not owned by one firm (accounts, firms themselves, built-in roles)
 *  - tenant:   every row belongs to exactly one org via org_id; queries run with
 *              the org context set (row-level security policies arrive in F8.1)
 */
export type TableScope = 'platform' | 'tenant';

export const TABLE_CATALOG = {
  users: 'platform',
  user_profiles: 'platform',
  orgs: 'platform',
  roles: 'platform',
  memberships: 'tenant',
  invites: 'tenant',
} as const satisfies Record<string, TableScope>;

export type CatalogTable = keyof typeof TABLE_CATALOG;

/** Narrow an arbitrary string to a catalogued table, or throw. */
export function assertCatalogTable(name: string): CatalogTable {
  if (!Object.prototype.hasOwnProperty.call(TABLE_CATALOG, name)) {
    throw new Error(`Table "${name}" is not in the table catalog (server/src/db/tableCatalog.ts).`);
  }
  return name as CatalogTable;
}

export function tableScope(table: CatalogTable): TableScope {
  return TABLE_CATALOG[table];
}
