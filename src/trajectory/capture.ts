/**
 * Trajectory Capture
 * Builds a Trajectory object from task execution data
 */

import type { Trajectory, TrajectoryStep } from '../reasoningbank/db/schema.js';

export interface CaptureOptions {
  taskQuery: string;
  agentType: string;
  routedModel?: string;
  startTime: string;
  endTime: string;
  exitCode: number;
  outputLength?: number;
}

/**
 * Build a Trajectory from task execution data.
 * Returns a Trajectory with a spawn step and an execute step.
 */
export function captureTrajectory(opts: CaptureOptions): Trajectory {
  const spawnStep: TrajectoryStep = {
    action: 'spawn',
    agent: opts.agentType,
    query: opts.taskQuery,
    model: opts.routedModel || 'unknown',
    timestamp: opts.startTime,
  };

  const executeStep: TrajectoryStep = {
    action: 'execute',
    exitCode: opts.exitCode,
    outputLength: opts.outputLength ?? 0,
    timestamp: opts.endTime,
  };

  return {
    steps: [spawnStep, executeStep],
    metadata: {
      duration: new Date(opts.endTime).getTime() - new Date(opts.startTime).getTime(),
      agent: opts.agentType,
      model: opts.routedModel || 'unknown',
      started_at: opts.startTime,
      ended_at: opts.endTime,
    },
  };
}
