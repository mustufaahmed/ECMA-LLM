import OpenAI from 'openai';

/**
 * OpenAI "new stack" models should use the Responses API (not Chat Completions).
 *
 * Rules for GPT‑5.x / o‑series with `text.format.type: "json_object"`:
 * - The request input must explicitly mention "json" or the API returns 400.
 * - Do not send `temperature`, `top_p`, or Chat Completions `max_tokens`.
 * - Use only `max_output_tokens` on Responses API (not `max_completion_tokens`).
 */
export function openAIUsesResponsesApi(model: string): boolean {
  const m = model.toLowerCase();
  if (m.startsWith('gpt-5')) return true;
  if (m.startsWith('o')) return true; // o3, o3-mini, etc.
  return false;
}

/** Required when using json_object format: input/instructions must contain "json". */
function ensurePromptMentionsJson(text: string): string {
  const t = text.trim();
  if (/json/i.test(t)) return t;
  return `${t}\n\nReturn the output as valid JSON.`;
}

function extractResponsesOutputText(resp: OpenAI.Responses.Response): string {
  const out = resp.output ?? [];
  const parts: string[] = [];

  for (const item of out) {
    if (item.type !== 'message') continue;
    const msg = item as OpenAI.Responses.ResponseOutputMessage;
    for (const c of msg.content ?? []) {
      if (c.type === 'output_text' && 'text' in c) {
        parts.push(String((c as { text?: string }).text ?? ''));
      }
    }
  }

  return parts.join('').trim();
}

export async function callOpenAIResponsesJSON(opts: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
}): Promise<string> {
  const client = new OpenAI({ apiKey: opts.apiKey });

  const instructions = ensurePromptMentionsJson(opts.system);
  const input = ensurePromptMentionsJson(opts.user);

  const resp = await client.responses.create({
    model: opts.model,
    instructions,
    input,
    max_output_tokens: opts.maxOutputTokens,
    text: {
      format: { type: 'json_object' },
    },
    stream: false,
  });

  if (resp.status && resp.status !== 'completed') {
    throw new Error(`OpenAI Responses incomplete status: ${resp.status}`);
  }

  return extractResponsesOutputText(resp);
}
