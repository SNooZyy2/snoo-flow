/**
 * Phase 2 Gate Test: templateBasedDistill stores memories
 *
 * Gate: After distill without API key, `patterns` table has rows
 *
 * Validates:
 * 1. distillMemories() can be imported (Fix 7 — dynamic ModelRouter)
 * 2. With no API key, template-based path is used
 * 3. Template-based distill stores a pattern row in DB
 * 4. Pattern row has correct type and parseable pattern_data
 * 5. Corresponding embedding row exists in pattern_embeddings
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Force real transformers, no API keys
process.env.FORCE_TRANSFORMERS = '1';
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GOOGLE_GEMINI_API_KEY;

// Use a test-specific DB to avoid polluting .swarm/memory.db
const testDbPath = join(process.cwd(), '.swarm', 'test-phase2.db');
process.env.CLAUDE_FLOW_DB_PATH = testDbPath;

describe('Phase 2: templateBasedDistill stores memories', () => {
  before(async () => {
    // Ensure .swarm dir exists
    const dir = join(process.cwd(), '.swarm');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Run migrations to create schema
    const { runMigrations } = await import('../src/reasoningbank/db/queries.ts');
    await runMigrations();
  });

  after(async () => {
    // Close DB and clean up test file
    const { closeDb } = await import('../src/reasoningbank/db/queries.ts');
    closeDb();

    const { clearEmbeddingCache } = await import('../src/reasoningbank/utils/embeddings.ts');
    clearEmbeddingCache();

    // Remove test DB
    const { unlinkSync } = await import('fs');
    try { unlinkSync(testDbPath); } catch {}
  });

  it('distillMemories() imports without crashing (Fix 7)', async () => {
    const mod = await import('../src/reasoningbank/core/distill.ts');
    assert.ok(typeof mod.distillMemories === 'function', 'distillMemories should be a function');
  });

  it('distillMemories() stores pattern rows with no API key (Fix 3)', async () => {
    const { distillMemories } = await import('../src/reasoningbank/core/distill.ts');

    const trajectory = {
      steps: [
        { action: 'spawn', agent: 'coder', query: 'implement auth', timestamp: Date.now() - 5000 },
        { action: 'execute', exitCode: 0, outputLength: 1200, timestamp: Date.now() }
      ],
      metadata: { duration: 5000, agent: 'coder', model: 'sonnet' }
    };

    const verdict = {
      label: /** @type {'Success'} */ ('Success'),
      confidence: 0.8,
      reasons: ['exit code 0', 'output looks good']
    };

    const ids = await distillMemories(trajectory, verdict, 'implement JWT authentication', {
      taskId: 'test-task-1',
      agentId: 'test-agent-1',
      domain: 'auth'
    });

    assert.ok(Array.isArray(ids), 'should return array of IDs');
    assert.ok(ids.length > 0, `should store at least 1 memory, got ${ids.length}`);
  });

  it('stored pattern has correct type and parseable data', async () => {
    const db = new Database(testDbPath, { readonly: true });

    const rows = db.prepare(
      `SELECT * FROM patterns WHERE type = 'reasoning_memory'`
    ).all();

    assert.ok(rows.length > 0, `patterns table should have rows, found ${rows.length}`);

    const row = rows[0];
    assert.equal(row.type, 'reasoning_memory');

    const data = JSON.parse(row.pattern_data);
    assert.ok(data.title, 'pattern_data should have title');
    assert.ok(data.content, 'pattern_data should have content');
    assert.ok(data.source, 'pattern_data should have source');
    assert.equal(data.source.task_id, 'test-task-1');
    assert.equal(data.source.agent_id, 'test-agent-1');
    assert.equal(data.source.outcome, 'Success');
    assert.equal(data.domain, 'auth');

    db.close();
  });

  it('stored pattern has corresponding embedding', async () => {
    const db = new Database(testDbPath, { readonly: true });

    const row = db.prepare(`
      SELECT p.id, pe.dims, length(pe.vector) as vec_bytes
      FROM patterns p
      JOIN pattern_embeddings pe ON p.id = pe.id
      WHERE p.type = 'reasoning_memory'
    `).get();

    assert.ok(row, 'should have matching embedding row');
    assert.equal(row.dims, 384, `embedding dims should be 384, got ${row.dims}`);
    assert.equal(row.vec_bytes, 384 * 4, `vector should be 384 * 4 bytes, got ${row.vec_bytes}`);

    db.close();
  });

  it('confidence is set based on verdict label', async () => {
    const db = new Database(testDbPath, { readonly: true });

    const row = db.prepare(
      `SELECT confidence FROM patterns WHERE type = 'reasoning_memory' LIMIT 1`
    ).get();

    assert.ok(row, 'should have a pattern row');
    // Success verdict -> confidence 0.6
    assert.equal(row.confidence, 0.6, `confidence should be 0.6 for Success, got ${row.confidence}`);

    db.close();
  });
});
