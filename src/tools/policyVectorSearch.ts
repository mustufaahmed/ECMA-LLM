import { qdrant } from '../db/qdrant';
import { env } from '../config/env';
import { embedPolicyQuery } from '../llm/embeddings';

export interface PolicyHit {
  score: number;
  docType: string;
  title: string;
  content: string;
  source: string;
}

export async function searchPolicy(
  query: string,
  opts: { topK?: number; collection?: string; filterDocType?: string } = {}
): Promise<PolicyHit[]> {
  const topK = opts.topK ?? 3;
  const vector = await embedPolicyQuery(query);

  const collection = opts.collection ?? env.QDRANT_COLLECTION;
  const results = await qdrant.search(collection, {
    vector,
    limit: topK,
    with_payload: true,
    ...(opts.filterDocType
      ? {
          filter: {
            must: [{ key: 'docType', match: { value: opts.filterDocType } }],
          },
        }
      : {}),
  });

  return results.map((r) => {
    const payload = (r.payload || {}) as Record<string, unknown>;
    return {
      score: r.score,
      docType: String(payload.docType ?? 'unknown'),
      title: String(payload.title ?? ''),
      content: String(payload.content ?? ''),
      source: String(payload.source ?? ''),
    };
  });
}
