import { callJSON } from '../llm/jsonCall';
import type { GraphState } from '../graph/state';

function buildSystem(closing: string): string {
  return `You are the Refiner agent - the final quality gate.
Tasks:
- Fix any grammar or clarity issues
- Ensure the response flows naturally
- Keep to at most 3 short paragraphs
- Must end with this exact line: "${closing}"
- Do NOT change factual content (order IDs, amounts, dates, tracking numbers must stay exactly the same).
Output ONLY valid JSON:
{
  "final_response": "the final polished response ready for the customer"
}`;
}

interface RefinerOut {
  final_response: string;
}

export async function runRefiner(state: GraphState): Promise<Partial<GraphState>> {
  const bestDraft =
    state.correctedDraft || state.personaDraft || state.draft || '';
  const closing =
    state.personaClosingLine || 'Is there anything else I can help you with?';

  const out = await callJSON<RefinerOut>(
    buildSystem(closing),
    `Draft to refine: "${bestDraft}"`,
    { apiKey: state.runtime.apiKey, platform: state.runtime.platform, model: state.runtime.model }
  );
  const safe: RefinerOut = out ?? { final_response: bestDraft };

  const trace = {
    agent: 'Refiner',
    cls: 'tf',
    note:
      state.refinementCount > 0
        ? `Final polish complete (loop #${state.refinementCount + 1})`
        : 'Final polish complete',
  };
  state.runtime.emit?.({ type: 'agent_done', agent: 'Refiner', trace });

  return {
    finalResponse: safe.final_response || bestDraft,
    refinementCount: state.refinementCount + 1,
    trace: [...state.trace, trace],
  };
}
