/**
 * A complete environment for unit tests. Every value is a throwaway test fixture,
 * not a credential: tests never connect to a real database, bucket or model server.
 */
export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3999',
  DB_HOST: 'localhost',
  DB_NAME: 'medexregai_test',
  DB_USER: 'test_user',
  DB_PASSWORD: 'unit-test-fixture-db', // projexlight-ignore SEC-SECRET-03: unit-test fixture, no real DB
  JWT_SECRET: 'unit-test-fixture-jwt-signing-key-0123456789', // projexlight-ignore SEC-SECRET-03: unit-test fixture
  ENCRYPTION_KEY: '0'.repeat(64),
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'medexregai-test',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'unit-test-fixture-s3', // projexlight-ignore SEC-SECRET-03: unit-test fixture
  AI_BASE_URL: 'http://localhost:11434',
  AI_GENERATION_MODEL: 'qwen2.5:7b-instruct',
  AI_EMBEDDING_MODEL: 'bge-m3',
};

Object.assign(process.env, TEST_ENV);
