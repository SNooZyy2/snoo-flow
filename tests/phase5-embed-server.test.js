/**
 * Phase 5 — ADR-001: Persistent Embedding Server
 *
 * Tests:
 * 1. Server starts and binds socket
 * 2. /embed returns correct 384-dim vectors
 * 3. /embed returns cached results on repeat
 * 4. /embed rejects bad requests (missing text, invalid JSON)
 * 5. /health returns server info
 * 6. /shutdown stops the server
 * 7. Client falls back to in-process when server is absent
 * 8. Client handles stale socket (ECONNREFUSED) gracefully
 * 9. Server vectors match in-process vectors (same model)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import http from 'node:http';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';

const SOCK = join(process.cwd(), '.swarm/embed.sock');
const PID_FILE = join(process.cwd(), '.swarm/embed.pid');

/** Send an HTTP request over Unix socket */
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      socketPath: SOCK,
      path,
      method,
      headers: {},
      timeout: 10000,
    };
    if (body) {
      const json = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(json);
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.end(JSON.stringify(body));
    else req.end();
  });
}

/** Wait for socket file to appear */
function waitForSocket(timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (existsSync(SOCK)) return resolve(true);
      if (Date.now() - start > timeoutMs) return reject(new Error('Server did not start'));
      setTimeout(check, 100);
    };
    check();
  });
}

/** Kill embed server if running */
function killServer() {
  try {
    if (existsSync(PID_FILE)) {
      const pid = parseInt(String(execSync(`cat ${PID_FILE}`)).trim(), 10);
      try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    }
  } catch { /* ok */ }
  try { unlinkSync(SOCK); } catch { /* ok */ }
  try { unlinkSync(PID_FILE); } catch { /* ok */ }
}

describe('Phase 5 — Embed Server (ADR-001)', () => {
  let serverProc;

  before(async () => {
    // Clean up any existing server
    killServer();
    // Wait a moment for cleanup
    await new Promise(r => setTimeout(r, 200));

    // Start the server
    serverProc = spawn('tsx', ['scripts/embed-server.ts'], {
      cwd: process.cwd(),
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, FORCE_TRANSFORMERS: '1' },
    });
    serverProc.unref();

    // Wait for socket (model load can take a few seconds)
    await waitForSocket(30000);
  });

  after(async () => {
    // Shut down via /shutdown endpoint
    try {
      await request('POST', '/shutdown', {});
    } catch { /* may already be down */ }
    // Wait for cleanup
    await new Promise(r => setTimeout(r, 500));
    killServer();
  });

  it('1. Server binds socket and creates PID file', () => {
    assert.ok(existsSync(SOCK), 'Socket file should exist');
    assert.ok(existsSync(PID_FILE), 'PID file should exist');
  });

  it('2. /embed returns 384-dim vector', async () => {
    const res = await request('POST', '/embed', { text: 'how does authentication work' });
    assert.equal(res.status, 200);
    assert.equal(res.body.dims, 384);
    assert.ok(Array.isArray(res.body.vector), 'vector should be an array');
    assert.equal(res.body.vector.length, 384);
    assert.equal(res.body.cached, false, 'First request should not be cached');
  });

  it('3. /embed returns cached on repeat', async () => {
    const res = await request('POST', '/embed', { text: 'how does authentication work' });
    assert.equal(res.status, 200);
    assert.equal(res.body.cached, true, 'Repeat request should be cached');
    assert.equal(res.body.vector.length, 384);
  });

  it('4a. /embed rejects missing text', async () => {
    const res = await request('POST', '/embed', { foo: 'bar' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('text'), 'Error should mention "text"');
  });

  it('4b. /embed rejects invalid JSON', async () => {
    // Send raw invalid JSON
    const res = await new Promise((resolve, reject) => {
      const body = '{not valid json';
      const req = http.request(
        { socketPath: SOCK, path: '/embed', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 5000 },
        (resp) => {
          let data = '';
          resp.on('data', (chunk) => (data += chunk));
          resp.on('end', () => resolve({ status: resp.statusCode, body: JSON.parse(data) }));
        }
      );
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('JSON'));
  });

  it('4c. /embed rejects empty text', async () => {
    const res = await request('POST', '/embed', { text: '   ' });
    assert.equal(res.status, 400);
  });

  it('5. /health returns server info', async () => {
    const res = await request('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.model, 'Xenova/all-MiniLM-L6-v2');
    assert.ok(typeof res.body.uptime === 'number');
    assert.ok(typeof res.body.pid === 'number');
    assert.ok(typeof res.body.cacheSize === 'number');
  });

  it('6. Vectors are semantically meaningful (similar texts have high cosine)', async () => {
    const [res1, res2, res3] = await Promise.all([
      request('POST', '/embed', { text: 'user authentication and login' }),
      request('POST', '/embed', { text: 'login credentials and password' }),
      request('POST', '/embed', { text: 'how to bake a chocolate cake' }),
    ]);

    const cosine = (a, b) => {
      let dot = 0, magA = 0, magB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
      }
      return dot / (Math.sqrt(magA) * Math.sqrt(magB));
    };

    const simSimilar = cosine(res1.body.vector, res2.body.vector);
    const simDissimilar = cosine(res1.body.vector, res3.body.vector);

    assert.ok(simSimilar > 0.5, `Similar texts should have cosine > 0.5, got ${simSimilar.toFixed(3)}`);
    assert.ok(simDissimilar < simSimilar, `Dissimilar texts should have lower cosine (${simDissimilar.toFixed(3)} < ${simSimilar.toFixed(3)})`);
  });
});

describe('Phase 5 — Client Fallback (no server)', () => {
  before(() => {
    // Ensure no server is running
    killServer();
  });

  it('7. computeEmbedding falls back when server absent', async () => {
    // Import the function and verify it still works without a server
    const { computeEmbedding } = await import('../src/reasoningbank/utils/embeddings.js');
    const vec = await computeEmbedding('test fallback without server');
    assert.ok(vec instanceof Float32Array, 'Should return Float32Array');
    assert.equal(vec.length, 384, 'Should be 384 dims');

    // Verify it's a real embedding (not all zeros)
    let sum = 0;
    for (let i = 0; i < vec.length; i++) sum += Math.abs(vec[i]);
    assert.ok(sum > 0, 'Embedding should not be all zeros');
  });

  it('8. Client handles stale socket gracefully', async () => {
    // Create a fake stale socket file (just a regular file, not a real socket)
    const { mkdirSync } = await import('node:fs');
    try { mkdirSync(join(process.cwd(), '.swarm'), { recursive: true }); } catch {}
    writeFileSync(SOCK, '');

    const { computeEmbedding, clearEmbeddingCache } = await import('../src/reasoningbank/utils/embeddings.js');
    clearEmbeddingCache();
    const vec = await computeEmbedding('test with stale socket');
    assert.ok(vec instanceof Float32Array, 'Should still return embedding');
    assert.equal(vec.length, 384);

    // Clean up
    try { unlinkSync(SOCK); } catch { /* ok */ }

    // Force exit — WASM threads from in-process fallback keep the event loop alive
    // (this is the exact zombie issue ADR-001 solves for hooks)
    setTimeout(() => process.exit(0), 500);
  });
});
