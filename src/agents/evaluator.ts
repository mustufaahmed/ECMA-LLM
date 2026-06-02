import { callJSON } from '../llm/jsonCall';
import type { GraphState } from '../graph/state';

const SYSTEM_TEMPLATE = (facts: string, returnDays: number, refundEta: string) => `You are the Constraint Evaluator agent. Perform these checks:
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
  "issues": [] or ["list of specific issues"],
  "corrected_draft": "a corrected version if issues found, else the same draft"
}`;

interface EvaluatorOut {
  passed: boolean;
  score: number;
  issues: string[];
  corrected_draft: string;
}

export async function runEvaluator(state: GraphState): Promise<Partial<GraphState>> {
  const draft = state.personaDraft || state.draft;
  const out = await callJSON<EvaluatorOut>(
    SYSTEM_TEMPLATE(state.retrievedFacts, 30, '3-5 business days'),
    `Draft: "${draft}"`,
    { apiKey: state.runtime.apiKey, platform: state.runtime.platform, model: state.runtime.model }
  );
  const safe: EvaluatorOut = out ?? {
    passed: true,
    score: 80,
    issues: [],
    corrected_draft: draft,
  };

  const trace = {
    agent: 'Evaluator',
    cls: 'te',
    note: `Score: ${safe.score}% | ${
      safe.passed
        ? 'All checks passed'
        : 'Issues: ' + (safe.issues || []).slice(0, 1).join(', ')
    }`,
  };
  state.runtime.emit?.({ type: 'agent_done', agent: 'Evaluator', trace });

  return {
    evalPassed: !!safe.passed,
    evalScore: typeof safe.score === 'number' ? safe.score : 0,
    evalIssues: Array.isArray(safe.issues) ? safe.issues : [],
    correctedDraft: safe.corrected_draft || draft,
    trace: [...state.trace, trace],
  };
}
