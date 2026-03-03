/**
 * Programmatic API for the learning-loop pipeline.
 * Wires: capture → judge → persist → distill → consolidate → SONA
 */

import { captureTrajectory, type CaptureOptions } from '../trajectory/capture.js';
import { judgeTrajectory, type Verdict } from '../reasoningbank/core/judge.js';
import { distillMemories } from '../reasoningbank/core/distill.js';
import { consolidate, shouldConsolidate } from '../reasoningbank/core/consolidate.js';
import { retrieveMemories, formatMemoriesForPrompt, type RetrievedMemory } from '../reasoningbank/core/retrieve.js';
import * as db from '../reasoningbank/db/queries.js';

// SONA is optional — dynamic import to avoid hard crash
let processTrajectory: ((outcome: any) => Promise<any>) | null = null;
try {
  ({ processTrajectory } = await import('../routing/sona-optimizer.js'));
} catch {
  // SONA unavailable — skip routing updates
}

export interface PostTaskOptions {
  taskId: string;
  taskQuery: string;
  agentType: string;
  routedModel?: string;
  startTime: string;
  endTime: string;
  exitCode: number;
  outputLength?: number;
  domain?: string;
}

export interface PostTaskResult {
  verdict: Verdict;
  memoryIds: string[];
  consolidated: boolean;
  sonaLearned: boolean;
}

/**
 * Full post-task pipeline:
 * 1. captureTrajectory → Trajectory
 * 2. judgeTrajectory  → Verdict
 * 3. db.storeTrajectory → persist
 * 4. distillMemories  → new pattern IDs
 * 5. shouldConsolidate → consolidate() if threshold met
 * 6. SONA processTrajectory (optional)
 */
export async function handlePostTask(opts: PostTaskOptions): Promise<PostTaskResult> {
  // 1. Capture
  const trajectory = captureTrajectory({
    taskQuery: opts.taskQuery,
    agentType: opts.agentType,
    routedModel: opts.routedModel,
    startTime: opts.startTime,
    endTime: opts.endTime,
    exitCode: opts.exitCode,
    outputLength: opts.outputLength,
  });

  // 2. Judge
  const verdict = await judgeTrajectory(trajectory, opts.taskQuery);

  // 3. Persist trajectory + verdict
  db.storeTrajectory({
    task_id: opts.taskId,
    agent_id: opts.agentType,
    query: opts.taskQuery,
    trajectory_json: JSON.stringify(trajectory),
    started_at: opts.startTime,
    ended_at: opts.endTime,
    judge_label: verdict.label,
    judge_conf: verdict.confidence,
    judge_reasons: JSON.stringify(verdict.reasons),
  });

  // 4. Distill memories
  const memoryIds = await distillMemories(trajectory, verdict, opts.taskQuery, {
    taskId: opts.taskId,
    agentId: opts.agentType,
    domain: opts.domain,
  });

  // 5. Consolidate if threshold met
  let consolidated = false;
  if (shouldConsolidate()) {
    await consolidate();
    consolidated = true;
  }

  // 6. SONA update (optional)
  let sonaLearned = false;
  if (processTrajectory) {
    try {
      const result = await processTrajectory({
        trajectoryId: opts.taskId,
        task: opts.taskQuery,
        agent: opts.agentType,
        success: verdict.label === 'Success',
        duration: new Date(opts.endTime).getTime() - new Date(opts.startTime).getTime(),
      });
      sonaLearned = result?.learned ?? false;
    } catch {
      // SONA failure is non-fatal
    }
  }

  return { verdict, memoryIds, consolidated, sonaLearned };
}

export interface PreTaskOptions {
  k?: number;
  domain?: string;
  agent?: string;
}

export interface PreTaskResult {
  memories: RetrievedMemory[];
  formatted: string;
}

/**
 * Pre-task: retrieve relevant memories for prompt injection.
 */
export async function handlePreTask(
  query: string,
  opts: PreTaskOptions = {},
): Promise<PreTaskResult> {
  const memories = await retrieveMemories(query, {
    k: opts.k,
    domain: opts.domain,
    agent: opts.agent,
  });

  return {
    memories,
    formatted: formatMemoriesForPrompt(memories),
  };
}
