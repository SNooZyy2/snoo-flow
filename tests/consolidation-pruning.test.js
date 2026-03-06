/**
 * Consolidation Pruning Tests
 *
 * Validates that memories with many contradictions get pruned,
 * and that high-usage contradicted memories are preserved.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';

// No API keys — use heuristic/template paths
process.env.FORCE_TRANSFORMERS = '1';
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GOOGLE_GEMINI_API_KEY;

const testDbPath = join(process.cwd(), '.swarm', 'test-consolidation.db');
process.env.CLAUDE_FLOW_DB_PATH = testDbPath;

describe('Consolidation: contradiction-based pruning', () => {
  let db;

  before(async () => {
    const dir = join(process.cwd(), '.swarm');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const { runMigrations } = await import('../src/reasoningbank/db/queries.ts');
    await runMigrations();
    db = (await import('../src/reasoningbank/db/queries.ts'));
  });

  after(async () => {
    const { closeDb } = await import('../src/reasoningbank/db/queries.ts');
    closeDb();
    const { clearEmbeddingCache } = await import('../src/reasoningbank/utils/embeddings.ts');
    clearEmbeddingCache();
    try { unlinkSync(testDbPath); } catch {}
  });

  it('prunes low-usage memories with 5+ contradictions', async () => {
    // Create a target memory (low usage, will be pruned)
    const targetId = 'test-target-001';
    db.upsertMemory({
      id: targetId,
      type: 'reasoning_memory',
      pattern_data: {
        title: 'Bad pattern',
        description: 'This should be pruned',
        content: 'When: testing\nDo: bad thing\nOutcome: mixed',
        source: { outcome: 'Success' },
        tags: ['test'],
        created_at: new Date().toISOString(),
        confidence: 0.5,
        n_uses: 0,
      },
      confidence: 0.5,
      usage_count: 0,
    });

    // Create 6 contradicting memories and link them
    for (let i = 0; i < 6; i++) {
      const contradictorId = `test-contradictor-${i}`;
      db.upsertMemory({
        id: contradictorId,
        type: 'reasoning_memory',
        pattern_data: {
          title: `Contradictor ${i}`,
          description: 'Contradicts the target',
          content: 'Opposite approach',
          source: { outcome: 'Failure' },
          tags: ['test'],
          created_at: new Date().toISOString(),
          confidence: 0.6,
          n_uses: 0,
        },
        confidence: 0.6,
        usage_count: 0,
      });
      db.storeLink(targetId, contradictorId, 'contradicts', 0.8);
    }

    // Run consolidation
    const { consolidate } = await import('../src/reasoningbank/core/consolidate.ts');
    const result = await consolidate();

    assert.ok(result.itemsPruned > 0, `Should prune at least 1 memory, pruned ${result.itemsPruned}`);

    // Verify target was deleted
    const remaining = db.getAllActiveMemories().filter(m => m.id === targetId);
    assert.equal(remaining.length, 0, 'Target memory should be deleted');
  });

  it('preserves high-usage memories even with many contradictions', async () => {
    const highUsageId = 'test-highusage-001';
    db.upsertMemory({
      id: highUsageId,
      type: 'reasoning_memory',
      pattern_data: {
        title: 'Popular pattern',
        description: 'Used often, should survive',
        content: 'When: testing\nDo: popular thing\nOutcome: Success',
        source: { outcome: 'Success' },
        tags: ['test'],
        created_at: new Date().toISOString(),
        confidence: 0.8,
        n_uses: 5,
      },
      confidence: 0.8,
      usage_count: 5,
    });

    // Add 6 contradictions
    for (let i = 0; i < 6; i++) {
      const contradictorId = `test-highusage-contra-${i}`;
      db.upsertMemory({
        id: contradictorId,
        type: 'reasoning_memory',
        pattern_data: {
          title: `HU Contradictor ${i}`,
          description: 'Contradicts the popular one',
          content: 'Opposite',
          source: { outcome: 'Failure' },
          tags: ['test'],
          created_at: new Date().toISOString(),
          confidence: 0.4,
          n_uses: 0,
        },
        confidence: 0.4,
        usage_count: 0,
      });
      db.storeLink(highUsageId, contradictorId, 'contradicts', 0.75);
    }

    const { consolidate } = await import('../src/reasoningbank/core/consolidate.ts');
    await consolidate();

    // High-usage memory should survive
    const remaining = db.getAllActiveMemories().filter(m => m.id === highUsageId);
    assert.equal(remaining.length, 1, 'High-usage memory should NOT be pruned');
  });
});
