import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createChatModel, ChatModelOptions } from './modelFactory';
import { env } from '../config/env';
import { callOpenAIResponsesJSON, openAIUsesResponsesApi } from './openaiResponses';

/**
 * Calls the chat model with a system + user prompt and forces JSON mode.
 * Returns the parsed JSON object (or null if the model output cannot be parsed).
 */
export async function callJSON<T = unknown>(
  system: string,
  user: string,
  opts: ChatModelOptions = {}
): Promise<T | null> {
  if (
    opts.platform === 'openai' &&
    opts.apiKey &&
    opts.model &&
    openAIUsesResponsesApi(opts.model)
  ) {
    const raw = await callOpenAIResponsesJSON({
      apiKey: opts.apiKey,
      model: opts.model,
      system,
      user,
      maxOutputTokens: opts.maxTokens ?? env.AGENT_MAX_TOKENS,
    });
    return parseJSON<T>(raw);
  }

  const model = createChatModel({ ...opts, jsonMode: true });
  const res = await model.invoke([
    new SystemMessage(system),
    new HumanMessage(user),
  ]);
  const raw =
    typeof res.content === 'string'
      ? res.content
      : Array.isArray(res.content)
      ? res.content
          .map((c) => (typeof c === 'string' ? c : 'text' in c ? c.text : ''))
          .join('')
      : '';
  return parseJSON<T>(raw);
}

export function parseJSON<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}
