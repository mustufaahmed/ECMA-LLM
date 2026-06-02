/**
 * ECMA-LLM multi-agent pipeline (LangGraph).
 *
 *   START -> Controller -> Retriever -> Generator -> Persona -> Evaluator -> Refiner
 *                                                                              |
 *                                                              (if eval failed & loops<max)
 *                                                                              v
 *                                                                       Evaluator (re-check)
 *
 * Every agent emits an 'agent_done' SSE event so the HTML UI can animate the
 * agent pipeline on the left side of the chat window.
 */
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import type { GraphState, TraceEntry, AgentEmitter } from './state';
import { initialState } from './state';
import { env } from '../config/env';
import { runController } from '../agents/controller';
import { runRetriever } from '../agents/retriever';
import { runGenerator } from '../agents/generator';
import { runPersona } from '../agents/persona';
import { runEvaluator } from '../agents/evaluator';
import { runRefiner } from '../agents/refiner';
import { prisma } from '../db/prisma';
import { logger } from '../utils/logger';

const StateAnnotation = Annotation.Root({
  query: Annotation<string>(),
  apiKey: Annotation<string | undefined>(),
  model: Annotation<string | undefined>(),
  sessionId: Annotation<string | undefined>(),

  intent: Annotation<string>(),
  entities: Annotation<Record<string, string | null>>(),
  complexity: Annotation<string>(),
  summary: Annotation<string>(),

  retrievedFacts: Annotation<string>(),
  dataSource: Annotation<string>(),
  confidence: Annotation<number>(),
  missingData: Annotation<string>(),

  draft: Annotation<string>(),
  dataUsed: Annotation<boolean>(),
  completeness: Annotation<string>(),

  personaDraft: Annotation<string>(),
  personaChanges: Annotation<string>(),

  evalPassed: Annotation<boolean>(),
  evalScore: Annotation<number>(),
  evalIssues: Annotation<string[]>(),
  correctedDraft: Annotation<string>(),
  refinementCount: Annotation<number>(),

  finalResponse: Annotation<string>(),

  trace: Annotation<TraceEntry[]>({
    default: () => [],
    reducer: (_prev, next) => next,
  }),

  personaBrand: Annotation<string | undefined>(),
  personaRules: Annotation<Record<string, unknown> | undefined>(),
  personaClosingLine: Annotation<string | undefined>(),

  runtime: Annotation<GraphState['runtime']>(),
});

function routeAfterRefiner(state: GraphState): 'loop' | 'end' {
  if (!state.evalPassed && state.refinementCount < state.runtime.maxRefinementLoops) {
    return 'loop';
  }
  return 'end';
}

function buildGraph() {
  return new StateGraph(StateAnnotation)
    .addNode('controller', runController)
    .addNode('retriever', runRetriever)
    .addNode('generator', runGenerator)
    .addNode('persona', runPersona)
    .addNode('evaluator', runEvaluator)
    .addNode('refiner', runRefiner)
    .addEdge(START, 'controller')
    .addEdge('controller', 'retriever')
    .addEdge('retriever', 'generator')
    .addEdge('generator', 'persona')
    .addEdge('persona', 'evaluator')
    .addEdge('evaluator', 'refiner')
    .addConditionalEdges('refiner', routeAfterRefiner, {
      loop: 'evaluator',
      end: END,
    })
    .compile();
}

let compiledGraph: ReturnType<typeof buildGraph> | null = null;

export function getPipeline() {
  if (!compiledGraph) compiledGraph = buildGraph();
  return compiledGraph;
}

export interface RunInput {
  query: string;
  apiKey?: string;
  platform: 'openai' | 'gemini' | 'anthropic';
  model?: string;
  sessionId?: string;
  userId?: string;
  emit?: AgentEmitter;
}

export interface RunResult {
  finalResponse: string;
  trace: TraceEntry[];
  meta: {
    mode?: 'multi' | 'single';
    pipeline?: 'a2a' | 'single';
    intent: string;
    evalPassed: boolean;
    evalScore: number;
    refinementCount: number;
    latencyMs: number;
    dataSource?: string;
    confidence?: number;
  };
}

export async function loadPersona(): Promise<
  Pick<GraphState, 'personaBrand' | 'personaRules' | 'personaClosingLine'>
> {
  const p = await prisma.personaSpec.findFirst({
    where: { personaId: 'shopmax-default' },
  });
  if (!p) {
    return {
      personaBrand: 'ShopMax',
      personaRules: {},
      personaClosingLine: 'Is there anything else I can help you with?',
    };
  }
  return {
    personaBrand: p.brand,
    personaRules: (p.rules as Record<string, unknown>) || {},
    personaClosingLine: p.closingLine,
  };
}

export async function persistTurn(input: RunInput, state: GraphState): Promise<void> {
  try {
    const userId = input.userId || 'demo-user';
    let convoId = input.sessionId;

    const existing = convoId
      ? await prisma.conversation.findUnique({ where: { id: convoId } })
      : null;

    if (!existing) {
      const created = await prisma.conversation.create({
        data: {
          userId,
          personaId: 'shopmax-default',
        },
      });
      convoId = created.id;
    }

    const turnCount = await prisma.turn.count({
      where: { conversationId: convoId! },
    });

    await prisma.turn.create({
      data: {
        conversationId: convoId!,
        turnNumber: turnCount + 1,
        userInput: input.query,
        systemResponse: state.finalResponse,
        intent: state.intent,
        entities: state.entities as object,
        evaluation: {
          passed: state.evalPassed,
          score: state.evalScore,
          issues: state.evalIssues,
        },
        refinementCount: state.refinementCount,
      },
    });
  } catch (err) {
    logger.warn('Failed to persist turn: %s', (err as Error).message);
  }
}

export async function runPipeline(input: RunInput): Promise<RunResult> {
  const t0 = Date.now();
  const persona = await loadPersona();

  const policyRagEnabled = !!env.OPENAI_API_KEY?.trim();

  const start = initialState({
    query: input.query,
    apiKey: input.apiKey,
    platform: input.platform,
    model: input.model,
    sessionId: input.sessionId,
    emit: input.emit,
    maxRefinementLoops: env.MAX_REFINEMENT_LOOPS,
    policyRagEnabled,
  });

  const initial: GraphState = {
    ...start,
    ...persona,
  };
  const graph = getPipeline();
  const final = (await graph.invoke(initial)) as GraphState;

  await persistTurn(input, final);

  const latencyMs = Date.now() - t0;
  return {
    finalResponse: final.finalResponse,
    trace: final.trace,
    meta: {
      mode: 'multi',
      pipeline: 'a2a',
      intent: final.intent,
      evalPassed: final.evalPassed,
      evalScore: final.evalScore,
      refinementCount: final.refinementCount,
      latencyMs,
      dataSource: final.dataSource,
      confidence: final.confidence,
    },
  };
}
