import { Router } from 'express';
import { prisma } from '../db/prisma';
import { qdrant } from '../db/qdrant';
import { env } from '../config/env';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    checks.mysql = { ok: true };
  } catch (err) {
    checks.mysql = { ok: false, detail: (err as Error).message };
  }

  try {
    const cols = await qdrant.getCollections();
    const hasCol = cols.collections.some(
      (c) => c.name === env.QDRANT_COLLECTION
    );
    checks.qdrant = {
      ok: hasCol,
      detail: hasCol
        ? `collection '${env.QDRANT_COLLECTION}' ready`
        : `collection '${env.QDRANT_COLLECTION}' missing - run npm run ingest`,
    };
  } catch (err) {
    checks.qdrant = { ok: false, detail: (err as Error).message };
  }

  checks.openai_rag = {
    ok: !!env.OPENAI_API_KEY?.trim(),
    detail: env.OPENAI_API_KEY?.trim()
      ? 'OPENAI_API_KEY set — policy RAG uses fixed text-embedding-3-small'
      : 'OPENAI_API_KEY missing — policy vector search disabled (set in .env for RAG)',
  };

  checks.llm_chat = {
    ok: true,
    detail: 'Chat provider is selected per-request (platform/model/apiKey).',
  };

  const allOk = Object.values(checks).every((c) => c.ok);
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
});
