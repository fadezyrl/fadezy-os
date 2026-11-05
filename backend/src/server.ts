import http from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';

const app = createApp();
const server = http.createServer(app);

function start(): void {
  server.listen(env.PORT, '0.0.0.0', () => {
    logger.info('API server started', {
      port: env.PORT,
      env: env.NODE_ENV,
      service: env.API_SERVICE_NAME,
      version: env.API_VERSION,
    });
  });
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info('Graceful shutdown initiated', { signal });

  server.close((closeError) => {
    if (closeError) {
      logger.error('Error while closing HTTP server', {
        errorMessage: closeError.message,
      });
      process.exit(1);
      return;
    }

    logger.info('HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    errorName: error.name,
    errorMessage: error.message,
  });
  void shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', {
    errorMessage: reason instanceof Error ? reason.message : String(reason),
  });
});

start();
