import { callJSON } from '../llm/jsonCall';
import type { GraphState } from '../graph/state';

function buildSystem(state: GraphState): string {
  const brand = state.personaBrand || 'ShopMax';
  const rules = state.personaRules || {};
  const forbidden =
    (rules.forbiddenPhrases as string[] | undefined)?.join(', ') ||
    'I apologize for any inconvenience';
  const maxSentences =
    (rules.maxSentencesPerPoint as number | undefined) ?? 3;
  return `You are the Persona Agent for the ${brand} e-commerce brand.
Brand voice rules:
- Warm and professional, never robotic
- Never use these phrases: ${forbidden}. Replace with direct empathy.
- No corporate jargon
- Max ${maxSentences} short sentences per point
- Preserve every concrete fact from the draft (order IDs, amounts, dates, tracking numbers must appear unchanged)
Output ONLY valid JSON:
{
  "persona_draft": "revised response with brand voice",
  "changes": "brief note on tone changes made"
}`;
}

interface PersonaOut {
  persona_draft: string;
  changes: string;
}

export async function runPersona(state: GraphState): Promise<Partial<GraphState>> {
  const out = await callJSON<PersonaOut>(
    buildSystem(state),
    `Draft to refine: "${state.draft}"`,
    { apiKey: state.runtime.apiKey, platform: state.runtime.platform, model: state.runtime.model }
  );
  const safe: PersonaOut = out ?? {
    persona_draft: state.draft,
    changes: 'none',
  };

  const trace = {
    agent: 'Persona',
    cls: 'tp',
    note: safe.changes || 'Brand tone applied',
  };
  state.runtime.emit?.({ type: 'agent_done', agent: 'Persona', trace });

  return {
    personaDraft: safe.persona_draft,
    personaChanges: safe.changes,
    trace: [...state.trace, trace],
  };
}
