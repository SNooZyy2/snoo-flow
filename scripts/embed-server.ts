#!/usr/bin/env tsx
/**
 * Persistent Embedding Server (ADR-001)
 *
 * Long-lived process that loads the ONNX embedding model once at startup
 * and serves embedding requests over a Unix domain socket.
 *
 * Endpoints:
 *   POST /embed    — { text: string } → { vector: number[], dims: 384, cached: bool }
 *   GET  /health   — { status: "ok", model: string, uptime: number, pid: number }
 *   POST /shutdown — graceful stop
 *
 * Lifecycle:
 *   - Socket at .swarm/embed.sock (exists ↔ ready)
 *   - PID file at .swarm/embed.pid
 *   - Self-exits after 30 min idle
 *   - Logs to .swarm/embed-server.log (1MB rotation)
 */

import http from 'node:http';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';

// -------------------------------------------------------------------
// Config
// -------------------------------------------------------------------
const SOCKET_PATH = join(process.cwd(), '.swarm/embed.sock');
const PID_PATH = join(process.cwd(), '.swarm/embed.pid');
const LOG_PATH = join(process.cwd(), '.swarm/embed-server.log');
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LRU_MAX = 1000;
const LOG_MAX_BYTES = 1 * 1024 * 1024; // 1 MB

// -------------------------------------------------------------------
// Logging (file-based, 1MB rotation)
// -------------------------------------------------------------------
let logStream: WriteStream | null = null;

function ensureSwarmDir() {
  const dir = join(process.cwd(), '.swarm');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function openLog() {
  ensureSwarmDir();
  logStream = createWriteStream(LOG_PATH, { flags: 'a' });
}

function rotateLog() {
  try {
    const stat = statSync(LOG_PATH);
    if (stat.size >= LOG_MAX_BYTES) {
      if (logStream) { logStream.end(); logStream = null; }
      renameSync(LOG_PATH, LOG_PATH + '.1');
      openLog();
    }
  } catch { /* file may not exist yet */ }
}

function log(msg: string) {
  rotateLog();
  if (!logStream) openLog();
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  logStream!.write(line);
}

// -------------------------------------------------------------------
// LRU Cache
// -------------------------------------------------------------------
const cache = new Map<string, number[]>();

function cacheGet(key: string): number[] | undefined {
  const val = cache.get(key);
  if (val !== undefined) {
    // Move to end (most recent)
    cache.delete(key);
    cache.set(key, val);
  }
  return val;
}

function cacheSet(key: string, val: number[]) {
  if (cache.size >= LRU_MAX) {
    // Evict oldest (first entry)
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, val);
}

// -------------------------------------------------------------------
// Embedding pipeline (loaded once)
// -------------------------------------------------------------------
let embeddingPipeline: any = null;

async function loadModel(): Promise<void> {
  // Same WASM config as embeddings.ts — must be set before import
  process.env.FORCE_TRANSFORMERS = '1';

  const { pipeline, env } = await import('@xenova/transformers');
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.numThreads = 1;

  log('Loading model Xenova/all-MiniLM-L6-v2...');
  embeddingPipeline = await pipeline(
    'feature-extraction',
    'Xenova/all-MiniLM-L6-v2',
    { quantized: true }
  );
  log('Model loaded successfully');
}

async function embed(text: string): Promise<{ vector: number[]; dims: number; cached: boolean }> {
  const cached = cacheGet(text);
  if (cached) return { vector: cached, dims: cached.length, cached: true };

  const output = await embeddingPipeline(text, { pooling: 'mean', normalize: true });
  const vector = Array.from(output.data as Float32Array);
  cacheSet(text, vector);
  return { vector, dims: vector.length, cached: false };
}

// -------------------------------------------------------------------
// Idle timeout
// -------------------------------------------------------------------
let lastRequestAt = Date.now();
let idleTimer: NodeJS.Timeout | null = null;

function resetIdle() {
  lastRequestAt = Date.now();
}

function startIdleCheck() {
  idleTimer = setInterval(() => {
    if (Date.now() - lastRequestAt > IDLE_TIMEOUT_MS) {
      log(`Idle for ${IDLE_TIMEOUT_MS / 60000} min — shutting down`);
      shutdown();
    }
  }, IDLE_CHECK_INTERVAL_MS);
  // Don't keep the process alive just for the idle check
  idleTimer.unref();
}

// -------------------------------------------------------------------
// HTTP Server
// -------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  resetIdle();

  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    const body = JSON.stringify({
      status: 'ok',
      model: 'Xenova/all-MiniLM-L6-v2',
      uptime: process.uptime(),
      pid: process.pid,
      cacheSize: cache.size,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  // POST /shutdown
  if (req.method === 'POST' && req.url === '/shutdown') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'shutting_down' }));
    shutdown();
    return;
  }

  // POST /embed
  if (req.method === 'POST' && req.url === '/embed') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      if (!parsed.text || typeof parsed.text !== 'string' || parsed.text.trim() === '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or empty "text" field' }));
        return;
      }

      try {
        const result = await embed(parsed.text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        log(`Embed error: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Embedding failed' }));
      }
    });
    return;
  }

  // Unknown route
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// -------------------------------------------------------------------
// Stale socket probe + startup
// -------------------------------------------------------------------
async function probeExistingSocket(): Promise<'live' | 'stale' | 'none'> {
  if (!existsSync(SOCKET_PATH)) return 'none';

  return new Promise((resolve) => {
    const client = net.createConnection({ path: SOCKET_PATH }, () => {
      // Connection succeeded — another instance is live
      client.destroy();
      resolve('live');
    });
    client.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') {
        // Stale socket from crashed server
        resolve('stale');
      } else {
        resolve('stale'); // Treat other errors as stale too
      }
    });
    // Short timeout for probe
    client.setTimeout(1000, () => {
      client.destroy();
      resolve('stale');
    });
  });
}

function writePidFile() {
  ensureSwarmDir();
  writeFileSync(PID_PATH, String(process.pid));
}

function cleanup() {
  try { unlinkSync(SOCKET_PATH); } catch { /* ok */ }
  try { unlinkSync(PID_PATH); } catch { /* ok */ }
  if (idleTimer) clearInterval(idleTimer);
  if (logStream) { logStream.end(); logStream = null; }
  cache.clear();
}

function shutdown() {
  log('Shutting down');
  server.close(() => {
    cleanup();
    process.exit(0);
  });
  // Force exit if close takes too long
  setTimeout(() => {
    cleanup();
    process.exit(0);
  }, 3000).unref();
}

// Graceful shutdown on signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------
async function main() {
  ensureSwarmDir();

  // Probe existing socket
  const probeResult = await probeExistingSocket();
  if (probeResult === 'live') {
    // Another instance is running — exit silently
    process.exit(0);
  }
  if (probeResult === 'stale') {
    try { unlinkSync(SOCKET_PATH); } catch { /* ok */ }
    log('Removed stale socket');
  }

  // Load model before binding socket (socket existence = ready)
  const loadStart = Date.now();
  await loadModel();
  const loadMs = Date.now() - loadStart;

  // Bind socket
  server.listen(SOCKET_PATH, () => {
    writePidFile();
    startIdleCheck();
    log(`Server ready on ${SOCKET_PATH} (model loaded in ${loadMs}ms, PID ${process.pid})`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // Race with another starter — exit silently
      log('EADDRINUSE — another instance won the race');
      process.exit(0);
    }
    log(`Server error: ${err.message}`);
    cleanup();
    process.exit(1);
  });
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  cleanup();
  process.exit(1);
});
