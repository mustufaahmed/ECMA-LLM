import type { RunInput, RunResult } from '../graph/pipeline';
import type { GraphState, TraceEntry } from '../graph/state';
import { initialState } from '../graph/state';
import { env } from '../config/env';
import { loadPersona, persistTurn } from '../graph/pipeline';
import { callJSON } from '../llm/jsonCall';
import { lookupOrderById, listUserOrders } from '../tools/orderLookup';
import { billingForOrder, latestBillingForUser } from '../tools/billingLookup';
import { searchCatalog } from '../tools/catalogSearch';
import { searchPolicy } from '../tools/policyVectorSearch';
import { logger } from '../utils/logger';

type SingleIntent =
  | 'order_status'
  | 'billing_dispute'
  | 'return_policy'
  | 'refund_policy'
  | 'warranty'
  | 'shipping'
  | 'product_recommendation'
  | 'account_issue'
  | 'multi_step'
  | 'general';

function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).replace(/[^0-9.]/g, '');
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function guessIntent(query: string): SingleIntent {
  const q = query.toLowerCase();
  if (q.includes('charged') || q.includes('charge') || q.includes('billing') || q.includes('refund status')) {
    return 'billing_dispute';
  }
  if (q.includes('return')) return 'return_policy';
  if (q.includes('refund')) return 'refund_policy';
  if (q.includes('warranty')) return 'warranty';
  if (q.includes('shipping') || q.includes('deliver') || q.includes('delivery') || q.includes('tracking')) return 'shipping';
  if (q.includes('account') || q.includes('locked') || q.includes('login')) return 'account_issue';
  if (q.includes('recommend') || q.includes('suggest') || q.includes('looking for') || q.includes('under $')) {
    return 'product_recommendation';
  }
  if (q.includes('order')) return 'order_status';
  return 'general';
}

function extractOrderId(query: string): string | null {
  const m = query.match(/\b(?:ord[-\s]*)?(\d{1,9})\b/i);
  return m ? m[1] : null;
}

function extractMaxPrice(query: string): number | undefined {
  const m = query.match(/(?:under|below|<=|less than)\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i) || query.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  return m ? toNumber(m[1]) : undefined;
}

function extractKeyword(query: string): string | undefined {
  const cleaned = query
    .replace(/\b(please|kindly|recommend|suggest|show|give|me|a|an|the|under|below|less|than|price|budget|for)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  // Keep it short so Prisma contains() stays effective.
  return cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned;
}

interface SingleAgentOut {
  final_response: string;
}

interface EvalOut {
  passed: boolean;
  score: number;
  issues: string[];
}

function buildEvaluatorSystem(facts: string, returnDays: number, refundEta: string): string {
  return `You are the Constraint Evaluator agent. Perform these checks:
1. Factual accuracy: Does the response match the retrieved facts EXACTLY (order IDs, amounts, dates, tracking numbers, statuses)?
2. Policy compliance: Return window = ${returnDays} days. Refunds take ${refundEta}.
3. No false promises: no commitments beyond policy limits.
4. No hallucinated data: every specific number, ID, or date must appear in the facts.

Facts (ground truth):
${facts}

Output ONLY valid JSON:
{
  "passed": true or false,
  "score": integer 0-100,
  "issues": [] or ["list of specific issues"]
}`;
}

function buildSystem(personaBrand: string, personaRules: Record<string, unknown>, closingLine: string): string {
  const forbidden =
    (personaRules.forbiddenPhrases as string[] | undefined)?.join(', ') ||
    'I apologize for any inconvenience';
  const maxSentences = (personaRules.maxSentencesPerPoint as number | undefined) ?? 3;

  return `You are a Single-Agent e-commerce support assistant for the ${personaBrand} brand.
You must answer using the provided facts and policy excerpts. You may summarize, but you MUST NOT invent any numbers, IDs, dates, or claims not present in the facts.

Hard rules:
- Use ONLY provided facts/policy excerpts for any concrete detail (order IDs, amounts, dates, tracking numbers, time windows).
- If information is missing, say so and ask for what you need (order id, email, etc.).
- Brand tone: warm and professional, never robotic.
- Never use these phrases: ${forbidden}. Replace with direct empathy.
- Max ${maxSentences} short sentences per point.
- Keep the answer to at most 3 short paragraphs.
- End with this exact line: "${closingLine}"

Output ONLY valid JSON:
{ "final_response": "..." }`;
}

function buildFactsBlock(opts: {
  intent: SingleIntent;
  orderId?: string | null;
  retrievedFacts: string;
  missingData: string;
}): string {
  return `User query: "${opts.retrievedFacts ? '' : ''}"
Intent: ${opts.intent}
OrderId: ${opts.orderId ?? 'null'}
Retrieved facts:
${opts.retrievedFacts}

Missing data:
${opts.missingData}`;
}

export async function runSingleAgent(input: RunInput): Promise<RunResult> {
  const t0 = Date.now();
  const persona = await loadPersona();
  const policyRagEnabled = !!env.OPENAI_API_KEY?.trim();

  const state: GraphState = {
    ...initialState({
      query: input.query,
      apiKey: input.apiKey,
      platform: input.platform,
      model: input.model,
      sessionId: input.sessionId,
      emit: input.emit,
      maxRefinementLoops: 0,
      policyRagEnabled,
    }),
    ...persona,
  };

  const traceEntries: TraceEntry[] = [];
  const emitTrace = (note: string) => {
    const trace = { agent: 'SingleAgent', cls: 'ts', note };
    traceEntries.push(trace);
    state.runtime.emit?.({ type: 'agent_done', agent: 'SingleAgent', trace });
  };

  const intent = guessIntent(input.query);
  const orderId = extractOrderId(input.query);
  const maxPrice = extractMaxPrice(input.query);
  const keyword = extractKeyword(input.query);

  let retrievedFactsParts: string[] = [];
  let dataSource = 'none';
  let missingData = 'none';

  try {
    if (intent === 'order_status') {
      if (orderId) {
        const o = await lookupOrderById(orderId);
        if (o) {
          retrievedFactsParts.push(
            `Order ${o.orderId}: status=${o.status}, item=${o.item}, carrier=${o.carrier}, tracking=${o.trackingNumber}, ETA=${o.estimatedDelivery}, amount=${o.amount}.`
          );
          dataSource = 'orders';
        } else {
          missingData = `Order ${orderId} not found in database.`;
        }
      } else {
        const recent = await listUserOrders(input.userId || 'demo-user', 3);
        if (recent.length) {
          retrievedFactsParts.push(
            'Recent orders: ' + recent.map((r) => `${r.orderId} (${r.status}, ${r.item})`).join('; ')
          );
          dataSource = 'orders';
        } else {
          missingData = 'No recent orders found for this user.';
        }
      }
    }

    if (intent === 'billing_dispute') {
      const bill = orderId
        ? await billingForOrder(orderId)
        : await latestBillingForUser(input.userId || 'demo-user');
      if (bill) {
        retrievedFactsParts.push(
          `Billing: lastCharge=${bill.lastChargeAmount} on ${bill.chargeDate}, duplicateDetected=${bill.duplicateDetected}, refundRef=${bill.refundRef}, refundEta=${bill.refundEta}, refundStatus=${bill.refundStatus}.`
        );
        dataSource = dataSource === 'none' ? 'billing' : 'mixed';
      } else {
        missingData = 'No recent billing record found for this user.';
      }
    }

    if (intent === 'product_recommendation') {
      const hits = await searchCatalog({
        maxPrice,
        keyword,
        limit: 5,
      });
      if (hits.length) {
        retrievedFactsParts.push(
          'Catalog candidates: ' +
            hits
              .map((h) => `${h.name} (${h.price}, ${h.stockLabel}, rating=${h.rating}, ${h.description ?? ''})`)
              .join(' | ')
        );
        dataSource = dataSource === 'none' ? 'catalog' : 'mixed';
      } else {
        missingData = 'No matching products in catalog for given filters.';
      }
    }

    const policyIntents = new Set<SingleIntent>([
      'return_policy',
      'refund_policy',
      'warranty',
      'shipping',
      'account_issue',
    ]);
    if (policyIntents.has(intent) && state.runtime.policyRagEnabled) {
      try {
        const policyHits = await searchPolicy(input.query, { topK: 3 });
        const filtered = policyHits.filter((p) => p.score >= env.POLICY_SIM_THRESHOLD);
        if (filtered.length) {
          retrievedFactsParts.push(
            'Policy excerpts: ' +
              filtered
                .map((p) => `[${p.docType}:${p.title} | sim=${p.score.toFixed(2)}] ${p.content.replace(/\s+/g, ' ')}`)
                .join(' --- ')
          );
          dataSource = dataSource === 'none' ? 'policy' : 'mixed';
        } else {
          missingData = 'No policy chunk matched query above similarity threshold.';
        }
      } catch (err) {
        logger.warn('Policy vector search failed: %s', (err as Error).message);
        missingData = 'Qdrant unavailable; policy context missing.';
      }
    }

    if (policyIntents.has(intent) && !state.runtime.policyRagEnabled) {
      missingData =
        'Policy RAG is disabled: set OPENAI_API_KEY on the server for fixed text-embedding-3-small ingest + retrieval.';
    }
  } catch (err) {
    logger.error('Single agent retrieval failed: %s', (err as Error).message);
    missingData = `Retrieval error: ${(err as Error).message}`;
  }

  const retrievedFacts =
    retrievedFactsParts.length ? retrievedFactsParts.join('\n') : 'No specific records were found for this query.';

  const sys = buildSystem(
    state.personaBrand || 'ShopMax',
    state.personaRules || {},
    state.personaClosingLine || 'Is there anything else I can help you with?'
  );

  const userPrompt = `User query: "${input.query}"
Intent guess: ${intent}
Data source: ${dataSource}

Retrieved facts / context:
${retrievedFacts}

Missing data:
${missingData}`;

  const out = await callJSON<SingleAgentOut>(sys, userPrompt, {
    apiKey: input.apiKey,
    platform: input.platform,
    model: input.model,
  });

  const finalResponse =
    out?.final_response ||
    `I can help with that, but I don’t have enough verified data yet.\n\n${state.personaClosingLine || 'Is there anything else I can help you with?'}`;

  const latencyMs = Date.now() - t0;

  emitTrace(`Intent: ${intent} | Source: ${dataSource} | Data used: ${dataSource !== 'none' ? 'yes' : 'no'}`);

  // Optional: run evaluator for baseline metrics (kept off by default)
  let evalPassed = true;
  let evalScore = 0;
  if (process.env.ECMA_BASELINE_EVAL === '1') {
    const evalOut = await callJSON<EvalOut>(
      buildEvaluatorSystem(retrievedFacts, 30, '3-5 business days'),
      `Draft: "${finalResponse}"`,
      { apiKey: input.apiKey, platform: input.platform, model: input.model }
    );
    if (evalOut) {
      evalPassed = !!evalOut.passed;
      evalScore = typeof evalOut.score === 'number' ? evalOut.score : 0;
      emitTrace(`Eval: score=${evalScore}% | ${evalPassed ? 'passed' : 'failed'}`);
    }
  }

  // Persist as a normal turn so your DB logs remain consistent
  state.intent = intent;
  state.retrievedFacts = retrievedFacts;
  state.dataSource = dataSource;
  state.missingData = missingData;
  state.evalPassed = evalPassed;
  state.evalScore = evalScore;
  state.refinementCount = 0;
  state.finalResponse = finalResponse;
  state.trace = traceEntries;

  await persistTurn(input, state);

  return {
    finalResponse,
    trace: traceEntries,
    meta: {
      mode: 'single',
      pipeline: 'single',
      intent,
      evalPassed,
      evalScore,
      refinementCount: 0,
      latencyMs,
      dataSource,
    },
  };
}

