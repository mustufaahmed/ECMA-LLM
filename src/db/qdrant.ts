import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const qdrant = new QdrantClient({
  url: env.QDRANT_URL,
  ...(env.QDRANT_API_KEY ? { apiKey: env.QDRANT_API_KEY } : {}),
});

/**
 * Ensures the policy collection exists with the configured embedding dimension.
 * Idempotent — safe to call at server boot and again from the ingestion script.
 */
export async function ensurePolicyCollection(params?: {
  collection?: string;
  dim?: number;
}): Promise<void> {
  const collection = params?.collection ?? env.QDRANT_COLLECTION;
  const dim = params?.dim ?? env.POLICY_EMBED_DIM;

  try {
    const existing = await qdrant.getCollections();
    const found = existing.collections.find((c) => c.name === collection);
    if (found) {
      logger.info(`Qdrant collection '${collection}' already exists.`);
      return;
    }
  } catch (err) {
    logger.error(
      'Could not list Qdrant collections. Is Qdrant running on ' +
        env.QDRANT_URL +
        '?',
      err as Error
    );
    throw err;
  }

  await qdrant.createCollection(collection, {
    vectors: { size: dim, distance: 'Cosine' },
  });
  logger.info(`Created Qdrant collection '${collection}' (dim=${dim}).`);
}
