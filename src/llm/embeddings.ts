import { OpenAIEmbeddings } from '@langchain/openai';
import { env } from '../config/env';

/** Fixed policy/RAG embedding model — must match ingestion and query-time retrieval. */
export const POLICY_EMBEDDING_MODEL = 'text-embedding-3-small' as const;

const POLICY_EMBED_DIM = 1536;

function requireOpenAiKeyForRag(): string {
  const key = env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'OPENAI_API_KEY is not set in the server environment. It is required for policy embeddings (RAG).'
    );
  }
  return key;
}

function createPolicyEmbedder(): OpenAIEmbeddings {
  return new OpenAIEmbeddings({
    apiKey: requireOpenAiKeyForRag(),
    model: POLICY_EMBEDDING_MODEL,
    dimensions: POLICY_EMBED_DIM,
  });
}

/** Single query vector for Qdrant policy search (OpenAI only, env key). */
export async function embedPolicyQuery(text: string): Promise<number[]> {
  const embedder = createPolicyEmbedder();
  return embedder.embedQuery(text);
}

/** Batch embed for policy ingestion (same model + key as query path). */
export async function embedPolicyDocuments(texts: string[]): Promise<number[][]> {
  const embedder = createPolicyEmbedder();
  return embedder.embedDocuments(texts);
}
