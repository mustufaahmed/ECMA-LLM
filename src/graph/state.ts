export interface TraceEntry {
  agent: string;
  cls: string;
  note: string;
}

export interface AgentEvent {
  type: 'agent_start' | 'agent_done' | 'agent_error' | 'final';
  agent?: string;
  trace?: TraceEntry;
  finalResponse?: string;
  meta?: Record<string, unknown>;
  error?: string;
}

export type AgentEmitter = (evt: AgentEvent) => void;

export interface GraphState {
  // Inputs
  query: string;
  apiKey?: string;
  model?: string;
  sessionId?: string;

  // Controller
  intent: string;
  entities: Record<string, string | null>;
  complexity: string;
  summary: string;

  // Retriever
  retrievedFacts: string;
  dataSource: string;
  confidence: number;
  missingData: string;

  // Generator
  draft: string;
  dataUsed: boolean;
  completeness: string;

  // Persona
  personaDraft: string;
  personaChanges: string;

  // Evaluator
  evalPassed: boolean;
  evalScore: number;
  evalIssues: string[];
  correctedDraft: string;
  refinementCount: number;

  // Refiner
  finalResponse: string;

  // Tracing / streaming
  trace: TraceEntry[];

  // Personas resolved at boot
  personaBrand?: string;
  personaRules?: Record<string, unknown>;
  personaClosingLine?: string;

  // Runtime knobs passed to every agent
  runtime: {
    emit?: AgentEmitter;
    maxRefinementLoops: number;
    apiKey?: string;
    platform: 'openai' | 'gemini' | 'anthropic';
    model: string;
    /** True when `OPENAI_API_KEY` is set — required for Qdrant policy RAG. */
    policyRagEnabled: boolean;
  };
}

export function initialState(input: {
  query: string;
  apiKey?: string;
  platform: 'openai' | 'gemini' | 'anthropic';
  model?: string;
  sessionId?: string;
  emit?: AgentEmitter;
  maxRefinementLoops: number;
  policyRagEnabled: boolean;
}): GraphState {
  return {
    query: input.query,
    apiKey: input.apiKey,
    model: input.model,
    sessionId: input.sessionId,
    intent: 'general',
    entities: {},
    complexity: 'simple',
    summary: input.query,
    retrievedFacts: '',
    dataSource: 'none',
    confidence: 0,
    missingData: 'none',
    draft: '',
    dataUsed: false,
    completeness: 'insufficient',
    personaDraft: '',
    personaChanges: '',
    evalPassed: true,
    evalScore: 0,
    evalIssues: [],
    correctedDraft: '',
    refinementCount: 0,
    finalResponse: '',
    trace: [],
    runtime: {
      emit: input.emit,
      maxRefinementLoops: input.maxRefinementLoops,
      apiKey: input.apiKey,
      platform: input.platform,
      model: input.model || 'gpt-4o',
      policyRagEnabled: input.policyRagEnabled,
    },
  };
}
