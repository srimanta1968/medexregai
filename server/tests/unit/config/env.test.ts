import {
  DEFAULT_CORS_ORIGINS,
  loadConfig,
  optionalEnv,
  parseCorsOrigins,
  parseEncryptionKey,
  parseLlmProvider,
  parsePositiveInt,
  requireEnv,
} from '../../../src/config/env';
import { TEST_ENV } from '../../setup/test-env';
import { readFileSync } from 'fs';
import { join } from 'path';

const EXAMPLE_LINES: string[] = readFileSync(join(__dirname, '../../../.env.example'), 'utf8').split(/\r?\n/);
const EXAMPLE_KEYS: string[] = EXAMPLE_LINES.map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l)?.[1]).filter(
  (k): k is string => Boolean(k)
);
const REQUIRED_IN_EXAMPLE: string[] = EXAMPLE_LINES.filter((l) => /^[A-Z][A-Z0-9_]*=.*#.*REQUIRED/.test(l)).map(
  (l) => l.split('=')[0]
);

const env = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  ...TEST_ENV,
  ...overrides,
});

describe('requireEnv (fail closed on missing secrets)', () => {
  it('returns the trimmed value', () => {
    expect(requireEnv({ X: '  value ' }, 'X')).toBe('value');
  });

  it.each([undefined, '', '   '])('throws when the variable is %p', (value) => {
    expect(() => requireEnv({ X: value }, 'X')).toThrow(/Missing required environment variable X/);
  });
});

describe('optionalEnv', () => {
  it('uses the fallback only for unset or blank values', () => {
    expect(optionalEnv({}, 'X', 'fb')).toBe('fb');
    expect(optionalEnv({ X: ' ' }, 'X', 'fb')).toBe('fb');
    expect(optionalEnv({ X: 'set' }, 'X', 'fb')).toBe('set');
  });
});

describe('parsePositiveInt', () => {
  it('parses positive integers', () => {
    expect(parsePositiveInt('3000', 'PORT')).toBe(3000);
  });

  it.each(['0', '-1', '3.5', 'abc', ''])('rejects %p', (raw) => {
    expect(() => parsePositiveInt(raw, 'PORT')).toThrow(/PORT must be a positive integer/);
  });
});

describe('parseCorsOrigins', () => {
  it('always includes the platform and local dev origins', () => {
    expect(parseCorsOrigins(undefined)).toEqual([...DEFAULT_CORS_ORIGINS]);
  });

  it('adds extra origins, trims trailing slashes and de-duplicates', () => {
    const origins = parseCorsOrigins(' https://app.example.com/ , http://localhost:5173,,');
    expect(origins).toContain('https://app.example.com');
    expect(origins.filter((o) => o === 'http://localhost:5173')).toHaveLength(1);
    expect(origins).not.toContain('');
  });
});

describe('parseLlmProvider', () => {
  it.each(['ollama', 'openai_compatible', 'anthropic'])('accepts %s', (p) => {
    expect(parseLlmProvider(p)).toBe(p);
  });

  it('rejects an unknown provider at startup', () => {
    expect(() => parseLlmProvider('olama')).toThrow(/AI_PROVIDER must be one of/);
  });
});

describe('parseEncryptionKey', () => {
  it('accepts 64 hex characters and normalises case', () => {
    expect(parseEncryptionKey('A'.repeat(64))).toBe('a'.repeat(64));
  });

  it.each(['abc', 'g'.repeat(64), '0'.repeat(63)])('rejects %p', (raw) => {
    expect(() => parseEncryptionKey(raw)).toThrow(/ENCRYPTION_KEY must be 64 hex characters/);
  });
});

describe('loadConfig', () => {
  it('builds a typed config from a complete environment', () => {
    const config = loadConfig(env());
    expect(config.port).toBe(3999);
    expect(config.db.name).toBe('medexregai_test');
    expect(config.llm.provider).toBe('ollama');
    expect(config.corsOrigins).toEqual(expect.arrayContaining([...DEFAULT_CORS_ORIGINS]));
  });

  it('defaults to our own local model provider', () => {
    expect(loadConfig(env({ AI_PROVIDER: undefined })).llm.provider).toBe('ollama');
  });

  it.each(REQUIRED_IN_EXAMPLE)('refuses to start without %s', (name) => {
    expect(() => loadConfig(env({ [name]: undefined }))).toThrow(new RegExp(name));
  });

  it('uses a real request-log format, falling back from unknown values such as "json"', () => {
    expect(loadConfig(env({ LOG_FORMAT: 'tiny' })).logFormat).toBe('tiny');
    expect(loadConfig(env({ LOG_FORMAT: 'json' })).logFormat).toBe('combined');
  });

  it('rejects a short JWT secret', () => {
    expect(() => loadConfig(env({ JWT_SECRET: 'short' }))).toThrow(/at least 32 characters/);
  });
});

describe('server/.env.example stays in step with the code', () => {
  it('marks at least the known secrets as REQUIRED', () => {
    expect(REQUIRED_IN_EXAMPLE).toEqual(
      expect.arrayContaining(['DB_PASSWORD', 'JWT_SECRET', 'ENCRYPTION_KEY'])
    );
  });

  it('marks every variable the code requires as REQUIRED, and nothing else', () => {
    // A key is required by the code when removing it alone makes loadConfig throw.
    const requiredByCode = Object.keys(TEST_ENV).filter((name) => {
      try {
        loadConfig(env({ [name]: undefined }));
        return false;
      } catch {
        return true;
      }
    });
    expect([...requiredByCode].sort()).toEqual([...REQUIRED_IN_EXAMPLE].sort());
  });

  it('declares every key the test environment needs', () => {
    for (const name of Object.keys(TEST_ENV)) {
      expect(EXAMPLE_KEYS).toContain(name);
    }
  });
});
