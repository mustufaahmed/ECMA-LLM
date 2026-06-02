import type { GraphState } from '../graph/state';
import { lookupOrderById, listUserOrders } from '../tools/orderLookup';
import { latestBillingForUser, billingForOrder } from '../tools/billingLookup';
import { searchCatalog } from '../tools/catalogSearch';
import { searchPolicy } from '../tools/policyVectorSearch';
import { logger } from '../utils/logger';
import { env } from '../config/env';

const POLICY_INTENTS = new Set([
  'return_policy',
  'refund_policy',
  'warranty',
  'shipping',
]);

function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).replace(/[^0-9.]/g, '');
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Retriever is the ONLY agent that touches real data. It fans out to tools
 * based on the intent produced by the Controller and produces a single
 * human-readable facts string that the Generator will use verbatim.
 */
export async function runRetriever(state: GraphState): Promise<Partial<GraphState>> {
  const parts: string[] = [];
  const sources: string[] = [];
  let confidence = 50;
  let missing = 'none';

  const entities = state.entities || {};
  const orderId = entities.order_id || null;
  const productKeyword = entities.product_keyword || null;
  const category = entities.category || null;
  const maxPrice = toNumber(entities.max_price);

  try {
    if (state.intent === 'order_status' || state.intent === 'multi_step') {
      if (orderId) {
        const o = await lookupOrderById(orderId);
        if (o) {
          parts.push(
            `Order ${o.orderId}: status=${o.status}, item=${o.item}, carrier=${o.carrier}, ` +
              `tracking=${o.trackingNumber}, ETA=${o.estimatedDelivery}, amount=${o.amount}.`
          );
          sources.push('orders');
          confidence = 95;
        } else {
          missing = `Order ${orderId} not found in database.`;
          confidence = 30;
        }
      } else {
        const recent = await listUserOrders('demo-user', 3);
        if (recent.length) {
          parts.push(
            'Recent orders: ' +
              recent
                .map((o) => `${o.orderId} (${o.status}, ${o.item})`)
                .join('; ')
          );
          sources.push('orders');
          confidence = 70;
        }
      }
    }

    if (state.intent === 'billing_dispute') {
      const bill = orderId
        ? await billingForOrder(orderId)
        : await latestBillingForUser('demo-user');
      if (bill) {
        parts.push(
          `Billing: lastCharge=${bill.lastChargeAmount} on ${bill.chargeDate}, ` +
            `duplicateDetected=${bill.duplicateDetected}, refundRef=${bill.refundRef}, ` +
            `refundEta=${bill.refundEta}, refundStatus=${bill.refundStatus}.`
        );
        sources.push('billing');
        confidence = 92;
      } else {
        missing = 'No recent billing record found for this user.';
        confidence = 30;
      }
    }

    if (state.intent === 'product_recommendation') {
      const hits = await searchCatalog({
        // Don't default to a category (e.g. "laptop") since TheLook dataset is apparel-focused.
        // If the controller didn't extract a category/keyword, return top-rated in-stock items.
        category: category || undefined,
        maxPrice,
        keyword: productKeyword || undefined,
        limit: 4,
      });
      if (hits.length) {
        parts.push(
          'Catalog candidates: ' +
            hits
              .map(
                (h) =>
                  `${h.name} (${h.price}, ${h.stockLabel}, rating=${h.rating}, ${
                    h.description ?? ''
                  })`
              )
              .join(' | ')
        );
        sources.push('catalog');
        confidence = 85;
      } else {
        missing = 'No matching products in catalog for given filters.';
        confidence = 35;
      }
    }

    if ((POLICY_INTENTS.has(state.intent) || state.intent === 'multi_step') && state.runtime.policyRagEnabled) {
      try {
        const policyHits = await searchPolicy(state.query, {
          topK: 3,
        });
        const filtered = policyHits.filter((p) => p.score >= env.POLICY_SIM_THRESHOLD);
        if (filtered.length) {
          parts.push(
            'Policy excerpts: ' +
              filtered
                .map(
                  (p) =>
                    `[${p.docType}:${p.title} | sim=${p.score.toFixed(2)}] ${p.content.replace(
                      /\s+/g,
                      ' '
                    )}`
                )
                .join(' --- ')
          );
          sources.push('policy');
          confidence = Math.max(confidence, Math.round(filtered[0].score * 100));
        } else if (POLICY_INTENTS.has(state.intent)) {
          missing = 'No policy chunk matched query above similarity threshold.';
        }
      } catch (err) {
        logger.warn('Policy vector search failed, continuing without it: %s', (err as Error).message);
        missing = 'Qdrant unavailable; policy context missing.';
      }
    }

    if (state.intent === 'account_issue' && state.runtime.policyRagEnabled) {
      try {
        const policyHits = await searchPolicy(state.query, {
          topK: 2,
          filterDocType: 'account',
        });
        const filtered = policyHits.filter((p) => p.score >= env.POLICY_SIM_THRESHOLD);
        if (filtered.length) {
          parts.push(
            'Account policy: ' +
              filtered
                .map((p) => p.content.replace(/\s+/g, ' '))
                .join(' --- ')
          );
          sources.push('policy');
          confidence = Math.max(confidence, 80);
        }
      } catch (err) {
        logger.warn('Account policy search failed: %s', (err as Error).message);
      }
    }

    if ((POLICY_INTENTS.has(state.intent) || state.intent === 'account_issue') && !state.runtime.policyRagEnabled) {
      missing =
        'Policy RAG is disabled: set OPENAI_API_KEY on the server for fixed text-embedding-3-small ingest + retrieval.';
    }
  } catch (err) {
    logger.error('Retriever error: %s', (err as Error).message);
    missing = `Retrieval error: ${(err as Error).message}`;
    confidence = 20;
  }

  const retrievedFacts =
    parts.length > 0 ? parts.join('\n') : 'No specific records were found for this query.';
  const dataSource =
    sources.length === 0
      ? 'none'
      : sources.length === 1
      ? sources[0]
      : 'mixed';

  const trace = {
    agent: 'Retriever',
    cls: 'tr2',
    note: `Source: ${dataSource} | Confidence: ${confidence}%`,
  };
  state.runtime.emit?.({ type: 'agent_done', agent: 'Retriever', trace });

  return {
    retrievedFacts,
    dataSource,
    confidence,
    missingData: missing,
    trace: [...state.trace, trace],
  };
}
