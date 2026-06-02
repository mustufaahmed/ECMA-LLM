/**
 * POST /api/chat          -> JSON response (simple clients)
 * POST /api/chat/stream   -> Server-Sent Events, one event per agent completion
 *
 * Both endpoints run the same LangGraph pipeline. Only /stream emits per-agent
 * progress, which the HTML UI uses to animate the agent pipeline on the left.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { runPipeline } from '../graph/pipeline';
import type { AgentEvent } from '../graph/state';
import { logger } from '../utils/logger';
import { runSingleAgent } from '../single/singleAgent';

export const chatRouter = Router();

const bodySchema = z.object({
  query: z.string().min(1).max(2000),
  platform: z.enum(['openai', 'gemini', 'anthropic']),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  mode: z.enum(['multi', 'single']).optional(),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
});

chatRouter.post('/', async (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  try {
    const mode = parsed.data.mode ?? 'multi';
    const result = mode === 'single' ? await runSingleAgent(parsed.data) : await runPipeline(parsed.data);
    res.json(result);
  } catch (err) {
    logger.error('Pipeline error: %s', (err as Error).message);
    res.status(500).json({
      error: 'Pipeline failed',
      message: (err as Error).message,
    });
  }
});

chatRouter.post('/stream', async (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Invalid request', details: parsed.error.flatten() });
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (evt: AgentEvent) => {
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch (err) {
      logger.warn('SSE write failed: %s', (err as Error).message);
    }
  };

  const mode = parsed.data.mode ?? 'multi';
  const agentOrder = mode === 'single'
    ? ['SingleAgent']
    : ['Controller', 'Retriever', 'Generator', 'Persona', 'Evaluator', 'Refiner'];
  let idx = 0;
  send({ type: 'agent_start', agent: agentOrder[0] });

  const emit = (evt: AgentEvent) => {
    send(evt);
    if (evt.type === 'agent_done') {
      idx++;
      const next = agentOrder[idx];
      if (next) send({ type: 'agent_start', agent: next });
    }
  };

  try {
    const result =
      mode === 'single'
        ? await runSingleAgent({ ...parsed.data, emit })
        : await runPipeline({ ...parsed.data, emit });
    send({
      type: 'final',
      finalResponse: result.finalResponse,
      meta: result.meta,
    });
    res.end();
  } catch (err) {
    logger.error('Stream pipeline error: %s', (err as Error).message);
    send({ type: 'agent_error', error: (err as Error).message });
    res.end();
  }
});
