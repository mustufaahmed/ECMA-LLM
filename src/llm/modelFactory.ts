import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { env } from '../config/env';

/**
 * Centralised chat-model factory. Today we only wire OpenAI, but the signature is
 * deliberately provider-agnostic so additional providers (Groq, Anthropic, Ollama)
 * can be added without touching agent code.
 */
export type LlmPlatform = 'openai' | 'gemini' | 'anthropic';

export interface ChatModelOptions {
  platform?: LlmPlatform;
  apiKey?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

export function createChatModel(opts: ChatModelOptions = {}): BaseChatModel {
  const platform: LlmPlatform = opts.platform ?? 'openai';
  const apiKey = opts.apiKey;
  if (!apiKey) {
    throw new Error('API key not provided. Pass apiKey in the request body.');
  }

  const temperature = opts.temperature ?? env.AGENT_TEMPERATURE;
  const maxTokens = opts.maxTokens ?? env.AGENT_MAX_TOKENS;

  if (platform === 'openai') {
    return new ChatOpenAI({
      apiKey,
      model: opts.model || 'gpt-4o',
      temperature,
      maxTokens,
      modelKwargs: opts.jsonMode ? { response_format: { type: 'json_object' } } : {},
    });
  }

  if (platform === 'anthropic') {
    return new ChatAnthropic({
      apiKey,
      model: opts.model || 'claude-3-5-sonnet-latest',
      temperature,
      maxTokens,
    });
  }

  // platform === 'gemini'
  return new ChatGoogleGenerativeAI({
    apiKey,
    model: opts.model || 'gemini-1.5-pro',
    temperature,
    maxOutputTokens: maxTokens,
  });
}
