/**
 * Memory Distillation from trajectories
 * Algorithm 3 from ReasoningBank paper
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ulid } from 'ulid';
import { loadConfig } from '../utils/config.js';
import { scrubMemory } from '../utils/pii-scrubber.js';
import { computeEmbedding } from '../utils/embeddings.js';
let ModelRouter: any = null;
try {
    // @ts-expect-error — router.js is optional; try/catch handles absence
    ({ ModelRouter } = await import('../../router/router.js'));
} catch {
    // ModelRouter unavailable -- template-based distillation will be used
}
import * as db from '../db/queries.js';
import type { Trajectory } from '../db/schema.js';
import type { Verdict } from './judge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize ModelRouter once
let routerInstance: any = null;
function getRouter(): any {
  if (!routerInstance && ModelRouter) {
    routerInstance = new ModelRouter();
  }
  return routerInstance;
}

export interface DistilledMemory {
  title: string;
  description: string;
  content: string;
  tags: string[];
  domain?: string;
}

/**
 * Distill memories from a trajectory
 */
export async function distillMemories(
  trajectory: Trajectory,
  verdict: Verdict,
  query: string,
  options: { taskId?: string; agentId?: string; domain?: string } = {}
): Promise<string[]> {
  const config = loadConfig();
  const startTime = Date.now();

  console.log(`[INFO] Distilling memories from ${verdict.label} trajectory`);

  // Select appropriate prompt template
  const templateName = verdict.label === 'Success' ? 'distill-success.json' : 'distill-failure.json';
  const promptPath = join(__dirname, '../prompts', templateName);
  const promptTemplate = JSON.parse(readFileSync(promptPath, 'utf-8'));

  const maxItems = verdict.label === 'Success'
    ? config.distill.max_items_success
    : config.distill.max_items_failure;

  const confidencePrior = verdict.label === 'Success'
    ? config.distill.confidence_prior_success
    : config.distill.confidence_prior_failure;

  // Check if we have any API key configured
  const hasApiKey = process.env.OPENROUTER_API_KEY ||
                    process.env.ANTHROPIC_API_KEY ||
                    process.env.GOOGLE_GEMINI_API_KEY;

  if (!hasApiKey || !ModelRouter) {
    console.warn('[WARN] No API key or ModelRouter unavailable, using template-based distillation');
    return templateBasedDistill(trajectory, verdict, query, options);
  }

  try {
    // Format trajectory
    const trajectoryText = JSON.stringify(trajectory.steps || [], null, 2);

    // Build prompt
    const prompt = promptTemplate.template
      .replace('{{task_query}}', query)
      .replace('{{trajectory}}', trajectoryText)
      .replace('{{max_items}}', String(maxItems));

    // Use ModelRouter for multi-provider support
    const router = getRouter();
    const response = await router.chat({
      model: config.distill.model || config.judge.model,
      messages: [
        { role: 'system', content: promptTemplate.system },
        { role: 'user', content: prompt }
      ],
      temperature: config.distill.temperature || 0.3,
      maxTokens: config.distill.max_tokens || 2048
    }, 'reasoningbank-distill');

    // Extract content from router response
    const content = response.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('\n');

    // Parse memories from response
    const distilled = parseDistilledMemories(content);

    // Store memories in database
    const memoryIds = await storeMemories(
      distilled,
      confidencePrior,
      verdict,
      options
    );

    const duration = Date.now() - startTime;
    console.log(`[INFO] Distilled ${memoryIds.length} memories in ${duration}ms`);
    db.logMetric('rb.distill.latency_ms', duration);
    db.logMetric('rb.distill.yield', memoryIds.length);

    return memoryIds;
  } catch (error) {
    console.error('[ERROR] Distillation failed:', error);
    return templateBasedDistill(trajectory, verdict, query, options);
  }
}

/**
 * Parse distilled memories from LLM response
 */
function parseDistilledMemories(content: string): DistilledMemory[] {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.memories || [];
    }
  } catch (error) {
    console.warn('[WARN] Failed to parse distilled memories JSON');
  }

  return [];
}

/**
 * Store memories in database
 */
async function storeMemories(
  memories: DistilledMemory[],
  confidencePrior: number,
  verdict: Verdict,
  options: { taskId?: string; agentId?: string; domain?: string }
): Promise<string[]> {
  const memoryIds: string[] = [];

  for (const mem of memories) {
    // Scrub PII
    const scrubbed = scrubMemory(mem);

    // Generate embedding
    const embedding = await computeEmbedding(
      `${scrubbed.title} ${scrubbed.description} ${scrubbed.content}`
    );

    // Create memory ID
    const id = ulid();

    // Store memory
    db.upsertMemory({
      id,
      type: 'reasoning_memory',
      pattern_data: {
        title: scrubbed.title,
        description: scrubbed.description,
        content: scrubbed.content,
        source: {
          task_id: options.taskId || 'unknown',
          agent_id: options.agentId || 'unknown',
          outcome: verdict.label,
          evidence: []
        },
        tags: scrubbed.tags,
        domain: options.domain || scrubbed.domain,
        created_at: new Date().toISOString(),
        confidence: confidencePrior,
        n_uses: 0
      },
      confidence: confidencePrior,
      usage_count: 0
    });

    // Store embedding
    db.upsertEmbedding({
      id,
      model: 'distill-' + verdict.label.toLowerCase(),
      dims: embedding.length,
      vector: embedding,
      created_at: new Date().toISOString()
    });

    memoryIds.push(id);
    console.log(`[INFO] Stored memory: ${scrubbed.title}`);
  }

  return memoryIds;
}

/**
 * Template-based distillation (fallback when no LLM API key)
 *
 * Extracts structured "when X, do Y because Z" patterns from the task
 * description and trajectory. Rejects trivial/uninformative tasks that
 * would just pollute the memory with command-log noise.
 */
async function templateBasedDistill(
  trajectory: Trajectory,
  verdict: Verdict,
  query: string,
  options: any
): Promise<string[]> {
  console.log('[INFO] Using template-based distillation (no API key)');

  // Gate: reject trivial tasks that won't produce useful patterns
  if (isTrivialTask(query)) {
    console.log('[INFO] Skipping distillation for trivial task');
    return [];
  }

  const memory = extractPattern(query, trajectory, verdict);
  if (!memory) {
    console.log('[INFO] Could not extract meaningful pattern');
    return [];
  }

  const confidencePrior = verdict.label === 'Success' ? 0.6 : 0.3;
  return storeMemories([memory], confidencePrior, verdict, options);
}

/**
 * Reject tasks that are too trivial to learn from:
 * - Very short queries (< 15 chars)
 * - Pure status checks, reads, or navigation
 * - Our own learning pipeline commands
 */
function isTrivialTask(query: string): boolean {
  if (query.length < 15) return true;

  const trivialPatterns = [
    /^(ls|cat|head|tail|echo|pwd|which|wc|tree|file|stat|mkdir)\b/,
    /^git\s+(status|diff|log|branch|remote|show)\b/,
    /^(npm run snoo|tsx scripts\/run)/,
    /^(curl|wget)\s.*\/(health|status|ping)\b/,
    /^(cd|pushd|popd)\s/,
    /^Write\s\S+\s\(\d+\sbytes\)$/,  // "Write foo.ts (200 bytes)" — no context
    /^Edit\s\S+:\s'.{0,10}'\s→\s'.{0,10}'$/,  // very short edits — no context
  ];

  return trivialPatterns.some(p => p.test(query));
}

/**
 * Extract a structured pattern from a task.
 * Returns null if the task doesn't contain enough signal.
 */
function extractPattern(
  query: string,
  trajectory: Trajectory,
  verdict: Verdict
): DistilledMemory | null {
  const steps = trajectory.steps || [];
  const isSuccess = verdict.label === 'Success';

  // Try to identify the type of work from the query
  const fileMatch = query.match(/(?:Edit|Write|Modify)\s+(\S+)/i);
  const commandMatch = query.match(/^(.+?)(?:\s+\d+)?$/);

  // For failures: the error itself is the insight
  if (!isSuccess) {
    return {
      title: `Failed: ${summarize(query, 60)}`,
      description: `This approach failed — avoid or adjust.`,
      content: buildFailureContent(query, steps),
      tags: ['failure', 'avoid', ...extractTags(query)],
    };
  }

  // For successful edits: capture what was changed and where
  if (fileMatch) {
    const file = fileMatch[1];
    return {
      title: `Pattern: ${summarize(query, 60)}`,
      description: `Successful modification to ${file}.`,
      content: `When working on ${file}: ${query}`,
      tags: ['success', 'edit', ...extractTags(query)],
    };
  }

  // For successful commands: capture the approach
  if (query.length >= 20) {
    return {
      title: `Approach: ${summarize(query, 60)}`,
      description: isSuccess
        ? 'This approach worked.'
        : 'This approach failed.',
      content: `When: ${inferContext(query)}\nDo: ${query}\nOutcome: ${verdict.label}`,
      tags: [verdict.label.toLowerCase(), ...extractTags(query)],
    };
  }

  return null;
}

/** Summarize a string to maxLen, breaking at word boundaries */
function summarize(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.substring(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.5 ? truncated.substring(0, lastSpace) : truncated) + '...';
}

/** Build useful failure content from query and steps */
function buildFailureContent(query: string, steps: any[]): string {
  const parts = [`Attempted: ${query}`];
  for (const step of steps) {
    if (step.exitCode && step.exitCode !== 0) {
      parts.push(`Exit code: ${step.exitCode}`);
    }
    if (step.error) {
      parts.push(`Error: ${String(step.error).substring(0, 200)}`);
    }
  }
  parts.push('Consider an alternative approach or check prerequisites.');
  return parts.join('\n');
}

/** Infer context from the command/description */
function inferContext(query: string): string {
  if (/npm|yarn|pnpm|bun/.test(query)) return 'running package manager commands';
  if (/git\s+(push|pull|merge|rebase|cherry)/.test(query)) return 'git operations';
  if (/test|spec|jest|vitest|mocha/.test(query)) return 'running tests';
  if (/build|compile|tsc|webpack|vite/.test(query)) return 'building the project';
  if (/deploy|release|publish/.test(query)) return 'deployment';
  if (/docker|container|k8s|kubectl/.test(query)) return 'container operations';
  if (/sql|migration|schema|database/.test(query)) return 'database operations';
  if (/supabase|rls|policy/.test(query)) return 'Supabase/RLS configuration';
  if (/Edit|Write|Modify/.test(query)) return 'editing files';
  return 'performing this task';
}

/** Extract semantic tags from the query */
function extractTags(query: string): string[] {
  const tags: string[] = [];
  const tagPatterns: [RegExp, string][] = [
    [/\b(test|spec|jest)\b/i, 'testing'],
    [/\b(build|compile|tsc)\b/i, 'build'],
    [/\b(deploy|release|publish)\b/i, 'deploy'],
    [/\b(sql|migration|schema|database|supabase)\b/i, 'database'],
    [/\b(auth|login|jwt|token|session)\b/i, 'auth'],
    [/\b(security|rls|policy|permission)\b/i, 'security'],
    [/\b(api|endpoint|route|handler)\b/i, 'api'],
    [/\b(docker|container|k8s)\b/i, 'infra'],
    [/\bgit\b/i, 'git'],
    [/\b(config|env|setup)\b/i, 'config'],
  ];
  for (const [pattern, tag] of tagPatterns) {
    if (pattern.test(query)) tags.push(tag);
  }
  return tags;
}
