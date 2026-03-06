/**
 * Lightweight ModelRouter for OpenRouter API
 *
 * Implements the `.chat()` interface expected by judge.ts and distill.ts.
 * Uses native fetch (no axios dependency). Auto-configures from env vars.
 * Maps Anthropic model IDs → OpenRouter format.
 */

const MODEL_MAP: Record<string, string> = {
  'claude-sonnet-4-5-20250929': 'anthropic/claude-sonnet-4.5',
  'claude-sonnet-4-20240620': 'anthropic/claude-sonnet-4',
  'claude-3-7-sonnet-20250219': 'anthropic/claude-3.7-sonnet',
  'claude-3-5-sonnet-20241022': 'anthropic/claude-3.5-sonnet-20241022',
  'claude-3-5-haiku-20241022': 'anthropic/claude-3.5-haiku-20241022',
  'claude-opus-4-1-20250514': 'anthropic/claude-opus-4.1',
  // Gemini models (pass through as-is on OpenRouter)
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

export class ModelRouter {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY || '';
    this.baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';

    if (!this.apiKey) {
      throw new Error('OPENROUTER_API_KEY is required for ModelRouter');
    }
  }

  async chat(params: ChatParams, _agentType?: string): Promise<ChatResponse> {
    const model = MODEL_MAP[params.model] || params.model;

    const body = {
      model,
      messages: params.messages.map(m => ({ role: m.role, content: m.content })),
      temperature: params.temperature ?? 0,
      max_tokens: params.maxTokens ?? 512,
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
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
