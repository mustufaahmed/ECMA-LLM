/**
 * Policy ingestion:
 *   1. Read every *.md file under ./policies
 *   2. Chunk by heading / paragraph (keeps section context for retrieval)
 *   3. Embed each chunk with OpenAI text-embedding-3-small (OPENAI_API_KEY from env)
 *   4. Upsert into Qdrant `QDRANT_COLLECTION`
 *
 * Run with: `npm run ingest`
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { qdrant, ensurePolicyCollection } from '../db/qdrant';
import { embedPolicyDocuments, POLICY_EMBEDDING_MODEL } from '../llm/embeddings';
import { env } from '../config/env';
import { logger } from '../utils/logger';

interface Chunk {
  id: string;
  docType: string;
  title: string;
  content: string;
  source: string;
}

const POLICY_DIR = path.join(__dirname, 'policies');
const MAX_CHARS = 1200;

function chunkMarkdown(raw: string, docType: string, source: string): Chunk[] {
  const lines = raw.split(/\r?\n/);
  const chunks: Chunk[] = [];
  let currentTitle = docType;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text.length === 0) return;
    if (text.length <= MAX_CHARS) {
      chunks.push({
        id: randomUUID(),
        docType,
        title: currentTitle,
        content: text,
        source,
      });
    } else {
      for (let i = 0; i < text.length; i += MAX_CHARS) {
        chunks.push({
          id: randomUUID(),
          docType,
          title: currentTitle,
          content: text.slice(i, i + MAX_CHARS),
          source,
        });
      }
    }
    buffer = [];
  };

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.*)$/);
    if (heading) {
      flush();
      currentTitle = heading[1].trim();
      buffer.push(line);
    } else {
      buffer.push(line);
    }
  }
  flush();
  return chunks;
}

function docTypeFromFile(file: string): string {
  return path.basename(file, path.extname(file));
}

async function main() {
  if (!env.OPENAI_API_KEY?.trim()) {
    throw new Error('OPENAI_API_KEY is required in .env for policy ingestion (text-embedding-3-small).');
  }

  const collection = env.QDRANT_COLLECTION;
  const dim = env.POLICY_EMBED_DIM;

  logger.info(
    `Ensuring Qdrant collection '${collection}' (dim=${dim}, embed=${POLICY_EMBEDDING_MODEL})...`
  );
  await ensurePolicyCollection({ collection, dim });

  const files = fs
    .readdirSync(POLICY_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(POLICY_DIR, f));

  if (files.length === 0) {
    logger.warn(`No markdown files found in ${POLICY_DIR}`);
    return;
  }

  logger.info(`Clearing previous chunks in '${collection}'...`);
  try {
    await qdrant.delete(collection, {
      filter: { must: [{ key: 'docType', match: { any: files.map(docTypeFromFile) } }] },
      wait: true,
    });
  } catch (err) {
    logger.warn('Could not clear old chunks (collection may be empty):', err as Error);
  }

  const allChunks: Chunk[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf-8');
    const docType = docTypeFromFile(file);
    const chunks = chunkMarkdown(raw, docType, path.basename(file));
    logger.info(`  ${docType}: ${chunks.length} chunks`);
    allChunks.push(...chunks);
  }

  logger.info(`Embedding ${allChunks.length} chunks with ${POLICY_EMBEDDING_MODEL}...`);
  const vectors = await embedPolicyDocuments(allChunks.map((c) => c.content));

  logger.info(`Upserting to Qdrant collection '${collection}'...`);
  await qdrant.upsert(collection, {
    wait: true,
    points: allChunks.map((c, i) => ({
      id: c.id,
      vector: vectors[i],
      payload: {
        docType: c.docType,
        title: c.title,
        content: c.content,
        source: c.source,
      },
    })),
  });

  logger.info('Ingestion complete.');
}

main()
  .catch((e) => {
    logger.error('Ingestion failed:', e);
    process.exit(1);
  })
  .then(() => process.exit(0));
