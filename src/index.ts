import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { env } from './config/env';
import { logger } from './utils/logger';
import { chatRouter } from './api/chat';
import { healthRouter } from './api/health';
import { ensurePolicyCollection } from './db/qdrant';

async function main() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use('/api/chat', chatRouter);
  app.use('/api/health', healthRouter);

  // Static UI (the user's existing HTML, adapted to call /api/chat/stream)
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled error: %s', err.message);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  });

  try {
    await ensurePolicyCollection();
  } catch (err) {
    logger.warn(
      'Qdrant not reachable at boot. Start it with `docker compose up -d` and then run `npm run ingest`. Error: %s',
      (err as Error).message
    );
  }

  app.listen(env.PORT, () => {
    logger.info(`ECMA-LLM server listening on http://localhost:${env.PORT}`);
    logger.info(`  UI:       http://localhost:${env.PORT}/`);
    logger.info(`  Health:   http://localhost:${env.PORT}/api/health`);
    logger.info(`  Chat:     POST http://localhost:${env.PORT}/api/chat`);
    logger.info(`  Stream:   POST http://localhost:${env.PORT}/api/chat/stream`);
  });
}

main().catch((err) => {
  logger.error('Fatal startup error: %s', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection: %s', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception: %s', err);
});
