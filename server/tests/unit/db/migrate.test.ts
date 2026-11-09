import { checksum, parseMigrationFiles, planMigrations } from '../../../src/db/migrate';
import { assertCatalogTable } from '../../../src/db/tableCatalog';

describe('migration planning (pure logic, no database)', () => {
  it('orders files by version and rejects bad names and duplicate versions', () => {
    const files = parseMigrationFiles([
      { fileName: '002_orgs.sql', sql: 'select 2' },
      { fileName: '001_extensions.sql', sql: 'select 1' },
      { fileName: 'README.md', sql: 'ignored' },
    ]);
    expect(files.map((f) => f.version)).toEqual([1, 2]);
    expect(files[0].checksum).toBe(checksum('select 1'));
    // CRLF and LF checkouts of the same file are the same migration.
    expect(checksum('a\r\nb')).toBe(checksum('a\nb'));

    expect(() => parseMigrationFiles([{ fileName: '1_bad.sql', sql: '' }])).toThrow(/NNN_snake_case/);
    expect(() =>
      parseMigrationFiles([
        { fileName: '001_a.sql', sql: '' },
        { fileName: '001_b.sql', sql: '' },
      ])
    ).toThrow(/share version 001/);
  });

  it('runs only pending files and reports edited or deleted history', () => {
    const files = parseMigrationFiles([
      { fileName: '001_extensions.sql', sql: 'select 1' },
      { fileName: '002_orgs.sql', sql: 'select 2 -- edited' },
      { fileName: '003_new.sql', sql: 'select 3' },
    ]);
    const plan = planMigrations(files, [
      { version: 1, name: 'extensions', checksum: checksum('select 1') },
      { version: 2, name: 'orgs', checksum: checksum('select 2') },
      { version: 9, name: 'gone', checksum: checksum('x') },
    ]);
    expect(plan.pending.map((f) => f.version)).toEqual([3]);
    expect(plan.changed).toEqual([{ version: 2, name: 'orgs' }]);
    expect(plan.missing).toEqual([{ version: 9, name: 'gone' }]);
  });

  it('only allows catalogued table names', () => {
    expect(assertCatalogTable('memberships')).toBe('memberships');
    expect(() => assertCatalogTable('users; drop table users')).toThrow(/not in the table catalog/);
  });
});
