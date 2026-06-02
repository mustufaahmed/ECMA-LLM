import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  QDRANT_URL: z.string().default('http://127.0.0.1:6333'),
  QDRANT_API_KEY: z.string().optional(),
  /** Qdrant collection for policy chunks (ingest + query use same vectors). */
  QDRANT_COLLECTION: z.string().default('policy_chunks'),
  /** Required for RAG: fixed `text-embedding-3-small` for ingest + query (not the UI chat key). */
  OPENAI_API_KEY: z.string().default(''),
  /** TheLook `users.id` used when the UI / pipeline still references `demo-user`. */
  DEMO_USER_ID: z.string().default('1'),
  POLICY_EMBED_DIM: z.coerce.number().default(1536),
  /** Minimum cosine similarity for policy chunks to be considered a hit. */
  POLICY_SIM_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),

  MAX_REFINEMENT_LOOPS: z.coerce.number().default(2),
  AGENT_TEMPERATURE: z.coerce.number().default(0.3),
  AGENT_MAX_TOKENS: z.coerce.number().default(700),
});

export const env = schema.parse(process.env);
export type Env = typeof env;
