/**
 * Lightweight ModelRouter for Anthropic + OpenRouter APIs
 *
 * Implements the `.chat()` interface expected by judge.ts and distill.ts.
 * Uses native fetch (no dependencies). Priority: ANTHROPIC_API_KEY > OPENROUTER_API_KEY.
 */

const OPENROUTER_MODEL_MAP: Record<string, string> = {
  'claude-sonnet-4-5-20250929': 'anthropic/claude-sonnet-4.5',
  'claude-sonnet-4-6-20250514': 'anthropic/claude-sonnet-4.6',
  'claude-sonnet-4-20240620': 'anthropic/claude-sonnet-4',
  'claude-3-7-sonnet-20250219': 'anthropic/claude-3.7-sonnet',
  'claude-3-5-sonnet-20241022': 'anthropic/claude-3.5-sonnet-20241022',
  'claude-3-5-haiku-20241022': 'anthropic/claude-3.5-haiku-20241022',
  'claude-opus-4-1-20250514': 'anthropic/claude-opus-4.1',
  'gemini-2.0-flash': 'google/gemini-2.0-flash-001',
  'gemini-2.5-flash': 'google/gemini-2.5-flash-preview',
};

interface ChatParams {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
}

interface ChatResponse {
  content: Array<{ type: 'text'; text: string }>;
  usage?: { inputTokens: number; outputTokens: number };
  metadata?: Record<string, unknown>;
}

type Provider = 'anthropic' | 'openrouter';

export class ModelRouter {
  private provider: Provider;
  private apiKey: string;

  constructor() {
    if (process.env.ANTHROPIC_API_KEY) {
      this.provider = 'anthropic';
      this.apiKey = process.env.ANTHROPIC_API_KEY;
    } else if (process.env.OPENROUTER_API_KEY) {
      this.provider = 'openrouter';
      this.apiKey = process.env.OPENROUTER_API_KEY;
    } else {
      throw new Error('ANTHROPIC_API_KEY or OPENROUTER_API_KEY is required');
    }
  }

  async chat(params: ChatParams, _agentType?: string): Promise<ChatResponse> {
    return this.provider === 'anthropic'
      ? this.chatAnthropic(params)
      : this.chatOpenRouter(params);
  }

  private async chatAnthropic(params: ChatParams): Promise<ChatResponse> {
    // Anthropic Messages API: system goes in top-level field, not in messages
    const systemMsg = params.messages.find(m => m.role === 'system');
    const userMsgs = params.messages.filter(m => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: params.model,
      messages: userMsgs.map(m => ({ role: m.role, content: m.content })),
      temperature: params.temperature ?? 0,
      max_tokens: params.maxTokens ?? 512,
    };
    if (systemMsg) body.system = systemMsg.content;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'unknown error');
      throw new Error(`Anthropic ${res.status}: ${err}`);
    }

    const data = await res.json() as any;

    return {
      content: data.content || [],
      usage: {
        inputTokens: data.usage?.input_tokens || 0,
        outputTokens: data.usage?.output_tokens || 0,
      },
      metadata: { provider: 'anthropic', model: params.model },
    };
  }

  private async chatOpenRouter(params: ChatParams): Promise<ChatResponse> {
    const model = OPENROUTER_MODEL_MAP[params.model] || params.model;
    const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

    const body = {
      model,
      messages: params.messages.map(m => ({ role: m.role, content: m.content })),
      temperature: params.temperature ?? 0,
      max_tokens: params.maxTokens ?? 512,
    };

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/SNooZyy2/snoo-flow',
        'X-Title': 'snoo-flow learning pipeline',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => 'unknown error');
      throw new Error(`OpenRouter ${res.status}: ${err}`);
    }

    const data = await res.json() as any;
    const choice = data.choices?.[0];

    return {
      content: [{ type: 'text', text: choice?.message?.content || '' }],
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
      metadata: { provider: 'openrouter', model },
    };
  }
}
