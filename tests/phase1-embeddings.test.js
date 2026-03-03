/**
 * Phase 1 Gate Test: Real Embeddings
 *
 * Validates:
 * 1. Embedding dimensions = 384 (all-MiniLM-L6-v2)
 * 2. cosine(embed("login auth"), embed("user auth")) > 0.7
 * 3. cosine(embed("login"), embed("banana")) < 0.3
 * 4. DEFAULT_CONFIG has provider=local, dims=384
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

// Force real transformers (not hash fallback)
process.env.FORCE_TRANSFORMERS = '1';

function cosine(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

describe('Phase 1: Real Embeddings', () => {
  after(async () => {
    const { clearEmbeddingCache } = await import('../src/reasoningbank/utils/embeddings.ts');
    clearEmbeddingCache();
  });

  it('DEFAULT_CONFIG has provider=local, dims=384', async () => {
    const { loadConfig, clearConfigCache } = await import('../src/reasoningbank/utils/config.ts');
    clearConfigCache();
    // Remove any YAML override by pointing to nonexistent path
    const config = loadConfig();
    assert.equal(config.embeddings.provider, 'local');
    assert.equal(config.embeddings.dims, 384);
    assert.equal(config.embeddings.dimensions, 384);
    assert.equal(config.embeddings.model, 'Xenova/all-MiniLM-L6-v2');
  });

  it('getEmbeddingDimensions() returns 384', async () => {
    const { getEmbeddingDimensions } = await import('../src/reasoningbank/utils/embeddings.ts');
    assert.equal(getEmbeddingDimensions(), 384);
  });

  it('computes 384-dim embeddings', async () => {
    const { computeEmbedding } = await import('../src/reasoningbank/utils/embeddings.ts');
    const vec = await computeEmbedding('test query');
    assert.equal(vec.length, 384, `Expected 384 dims, got ${vec.length}`);
  });

  it('cosine("login auth", "user auth") > 0.7', async () => {
    const { computeEmbedding } = await import('../src/reasoningbank/utils/embeddings.ts');
    const a = await computeEmbedding('login auth');
    const b = await computeEmbedding('user auth');
    const sim = cosine(a, b);
    console.log(`  cosine("login auth", "user auth") = ${sim.toFixed(4)}`);
    assert.ok(sim > 0.7, `Expected > 0.7, got ${sim.toFixed(4)}`);
  });

  it('cosine("login", "banana") < 0.3', async () => {
    const { computeEmbedding } = await import('../src/reasoningbank/utils/embeddings.ts');
    const a = await computeEmbedding('login');
    const b = await computeEmbedding('banana');
    const sim = cosine(a, b);
    console.log(`  cosine("login", "banana") = ${sim.toFixed(4)}`);
    assert.ok(sim < 0.3, `Expected < 0.3, got ${sim.toFixed(4)}`);
  });
});
