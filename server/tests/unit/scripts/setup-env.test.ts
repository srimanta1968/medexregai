import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../../../src/config/env';
import { makeSandbox, readEnv, runScript } from './script-harness';

jest.setTimeout(60_000);

describe('scripts/setup-env.sh', () => {
  it('creates server/.env with generated secrets that the API accepts', async () => {
    const box = makeSandbox();
    const result = await runScript(box, 'scripts/setup-env.sh', ['--db-password', 'localpw']);
    expect(result.code).toBe(0);

    const env = readEnv(join(box, 'server/.env'));
    expect(env.JWT_SECRET).toMatch(/^[0-9a-f]{96}$/);
    expect(env.ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(env.S3_SECRET_ACCESS_KEY).toMatch(/^[0-9a-f]{48}$/);
    // The API's own startup validation accepts what the script wrote.
    expect(() => loadConfig(env)).not.toThrow();
  });

  it('keeps the docker compose credentials in step with server/.env', async () => {
    const box = makeSandbox();
    await runScript(box, 'scripts/setup-env.sh', ['--db-password', 'localpw']);
    const server = readEnv(join(box, 'server/.env'));
    const root = readEnv(join(box, '.env'));
    expect(root.S3_ACCESS_KEY_ID).toBe(server.S3_ACCESS_KEY_ID);
    expect(root.S3_SECRET_ACCESS_KEY).toBe(server.S3_SECRET_ACCESS_KEY);
    // docker compose reads these for its Postgres and bucket
    expect(root.POSTGRES_PASSWORD).toBe(server.DB_PASSWORD);
    expect(root.POSTGRES_USER).toBe(server.DB_USER);
    expect(root.S3_BUCKET).toBe(server.S3_BUCKET);
  });

  it('exits 1 and says why when DB_PASSWORD is not provided (fail closed)', async () => {
    const box = makeSandbox();
    const result = await runScript(box, 'scripts/setup-env.sh');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/required DB_PASSWORD is blank/);
  });

  it('never changes existing values on a re-run', async () => {
    const box = makeSandbox();
    await runScript(box, 'scripts/setup-env.sh', ['--db-password', 'localpw']);
    const first = readEnv(join(box, 'server/.env'));
    const rerun = await runScript(box, 'scripts/setup-env.sh', ['--db-password', 'different']);
    expect(rerun.code).toBe(0);
    expect(readEnv(join(box, 'server/.env'))).toEqual(first);
  });

  it('replaces template placeholders and adds missing keys, keeping real values', async () => {
    const box = makeSandbox();
    writeFileSync(
      join(box, 'server/.env'),
      'PORT=4000\nDB_PASSWORD=keep_me\nJWT_SECRET=your_jwt_secret_key_change_this_in_production\n'
    );
    const result = await runScript(box, 'scripts/setup-env.sh');
    expect(result.code).toBe(0);
    const env = readEnv(join(box, 'server/.env'));
    expect(env.PORT).toBe('4000');
    expect(env.DB_PASSWORD).toBe('keep_me');
    expect(env.JWT_SECRET).toMatch(/^[0-9a-f]{96}$/);
    expect(env.REDIS_URL).toBeDefined();
  });

  it.each(['p#ss word', 'a\\b&c=d$e', "it's-fine", '  padded  '])(
    'stores DB_PASSWORD %p so dotenv reads it back unchanged',
    async (password) => {
      const box = makeSandbox();
      // Via the DB_PASSWORD env var: on Windows, Node -> MSYS bash re-parses argv and
      // would strip quotes before the script ever sees them.
      const result = await runScript(box, 'scripts/setup-env.sh', [], { DB_PASSWORD: password });
      expect(result.code).toBe(0);
      expect(readEnv(join(box, 'server/.env')).DB_PASSWORD).toBe(password);
    }
  );

  it('fails when a kept secret would be rejected by the API at startup', async () => {
    const box = makeSandbox();
    await runScript(box, 'scripts/setup-env.sh', ['--db-password', 'localpw']);
    const path = join(box, 'server/.env');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/^ENCRYPTION_KEY=.*$/m, "ENCRYPTION_KEY='not-hex'"));
    const result = await runScript(box, 'scripts/setup-env.sh');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/ENCRYPTION_KEY must be 64 hex characters/);
  });

  it('rotates only the JWT secret when asked', async () => {
    const box = makeSandbox();
    await runScript(box, 'scripts/setup-env.sh', ['--db-password', 'localpw']);
    const before = readEnv(join(box, 'server/.env'));
    await runScript(box, 'scripts/setup-env.sh', ['--rotate-jwt-secret']);
    const after = readEnv(join(box, 'server/.env'));
    expect(after.JWT_SECRET).not.toBe(before.JWT_SECRET);
    expect(after.ENCRYPTION_KEY).toBe(before.ENCRYPTION_KEY);
    expect(after.S3_SECRET_ACCESS_KEY).toBe(before.S3_SECRET_ACCESS_KEY);
  });

  it('reports a usage error for --db-password without a value', async () => {
    const box = makeSandbox();
    const result = await runScript(box, 'scripts/setup-env.sh', ['--db-password']);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/--db-password needs a value/);
  });
});
