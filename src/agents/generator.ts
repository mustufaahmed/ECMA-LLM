import { callJSON } from '../llm/jsonCall';
import type { GraphState } from '../graph/state';

const SYSTEM = `You are the Content Generator agent in an e-commerce support system.
Rules:
- Use ONLY the retrieved facts provided. Never invent data.
- Be specific: quote exact amounts, dates, order IDs, tracking numbers from facts.
- If data is missing, say so honestly and point the user to the right next step.
Output ONLY valid JSON:
{
  "draft": "your draft response",
  "data_used": true or false,
  "completeness": "full" | "partial" | "insufficient"
}`;

interface GeneratorOut {
  draft: string;
  data_used: boolean;
  completeness: string;
}

export async function runGenerator(state: GraphState): Promise<Partial<GraphState>> {
  const user = `User query: "${state.query}"
Intent: ${state.intent}
Retrieved facts: ${state.retrievedFacts}
Missing data: ${state.missingData}`;

  const out = await callJSON<GeneratorOut>(SYSTEM, user, {
    apiKey: state.runtime.apiKey,
    platform: state.runtime.platform,
    model: state.runtime.model,
  });
  const safe: GeneratorOut = out ?? {
    draft: 'I can help you with that. Could you share a little more detail?',
    data_used: false,
    completeness: 'insufficient',
  };

  const trace = {
    agent: 'Generator',
    cls: 'tg',
    note: `Draft: ${safe.completeness} | Data used: ${safe.data_used ? 'yes' : 'no'}`,
  };
  state.runtime.emit?.({ type: 'agent_done', agent: 'Generator', trace });

  return {
    draft: safe.draft,
    dataUsed: safe.data_used,
    completeness: safe.completeness,
    trace: [...state.trace, trace],
  };
}
