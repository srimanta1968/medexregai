/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // env.ts validates process.env at import, so tests get a complete, fake environment.
  setupFiles: ['<rootDir>/tests/setup/test-env.ts'],
  clearMocks: true,
};
