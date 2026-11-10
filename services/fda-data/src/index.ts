import { createApp } from './app';
import { config } from './config';
import { closePools } from './db/pool';
import { v1AdminRouter } from './v1/admin';
import { v1ReadRouter } from './v1/routes';

const app = createApp([v1ReadRouter, v1AdminRouter]);
const server = app.listen(config.port, () => {
  console.info(`[fda-data] API listening on port ${config.port}`);
});

const shutdown = (signal: string): void => {
  console.info(`[fda-data] ${signal}: shutting down`);
  server.close(() => {
    closePools()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
