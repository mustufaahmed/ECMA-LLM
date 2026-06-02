import { callJSON } from '../llm/jsonCall';
import type { GraphState } from '../graph/state';

const SYSTEM = `You are the Controller (Watcher) agent in a multi-agent e-commerce support system.
Your ONLY job: analyze the user query and output ONLY a valid JSON object - no extra text.
JSON schema:
{
  "intent": one of [order_status, billing_dispute, return_policy, refund_policy, warranty, shipping, product_recommendation, account_issue, multi_step, general],
  "entities": {"order_id": "if found or null", "amount": "if found or null", "product_keyword": "if found or null", "category": "if found or null", "max_price": "if found or null"},
  "complexity": "simple" or "complex",
  "summary": "one-line summary of what the user needs"
}`;

interface ControllerOut {
  intent: string;
  entities: Record<string, string | null>;
  complexity: string;
  summary: string;
}

export async function runController(state: GraphState): Promise<Partial<GraphState>> {
  const out = await callJSON<ControllerOut>(
    SYSTEM,
    `User query: "${state.query}"`,
    { apiKey: state.runtime.apiKey, platform: state.runtime.platform, model: state.runtime.model }
  );
  const safe: ControllerOut = out ?? {
    intent: 'general',
    entities: {},
    complexity: 'simple',
    summary: state.query,
  };
  const trace = {
    agent: 'Controller',
    cls: 'tc',
    note: `Intent: ${safe.intent} | ${safe.summary}`,
  };
  state.runtime.emit?.({ type: 'agent_done', agent: 'Controller', trace });
  return {
    intent: safe.intent,
    entities: safe.entities || {},
    complexity: safe.complexity || 'simple',
    summary: safe.summary || state.query,
    trace: [...state.trace, trace],
  };
}
