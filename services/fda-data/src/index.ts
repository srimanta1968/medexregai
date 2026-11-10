import { createApp } from './app';
import { config } from './config';
import { closePools } from './db/pool';

const app = createApp();
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
