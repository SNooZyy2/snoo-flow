# ADR-001: Persistent Embedding Server

**Status:** Proposed
**Date:** 2026-03-03
**Author:** snoozyy

## Context

snoo-flow's learning loop uses `Xenova/all-MiniLM-L6-v2` (a 23MB quantized ONNX model run via `@xenova/transformers` in WASM) to generate 384-dimensional embeddings for semantic memory retrieval. Embeddings are computed in five places:

| Hook / Caller | When | Embedding Operations |
|---|---|---|
| `retrieve.sh` → `run.ts pre` | Every `UserPromptSubmit` | 1 query embedding + cosine comparisons |
| `record.sh` → `run.ts post` | Every meaningful `Bash` tool use | 1-3 embeddings (distill + store) |
| `record-tool.sh` → `run.ts post` | Every `Edit`/`Write`/`Agent` tool use | 1-3 embeddings (distill + store) |
| `consolidate.sh` → `run.ts consolidate` | `SessionEnd` | N embeddings (dedup comparisons) |
| `handler.ts` (programmatic) | Direct API callers | Variable |

Each invocation spawns a **new Node.js process** (`tsx scripts/run.ts ...`). Every process must:

1. Start the tsx runtime (~200ms)
2. Import modules and run `bootstrap()` — open SQLite DB (~50ms)
3. Call `initializeEmbeddings()` — load ONNX model into WASM runtime (~255ms cold)
4. Compute the actual embedding (~3ms warm)

The model load at step 3 dominates. Measured on this machine:

| Scenario | Latency |
|---|---|
| Cold start (model load + inference) | **~255ms** |
| Warm inference (model already loaded) | **~3ms** |
| Cache hit (same text, in-memory Map) | **<1ms** |

The 255ms cold start happens on **every single hook invocation** because each is a fresh process. The `retrieve.sh` hook runs on every user prompt and has a 5000ms timeout — but 255ms of pure model-load overhead is still wasted work that could be <3ms.

For `record.sh` and `record-tool.sh`, which fire on every `Bash`/`Edit`/`Write`/`Agent` tool use, the background `tsx` processes also hold the WASM runtime open after completion, causing zombie-like behavior (the processes don't exit cleanly because WASM threads linger). This was observed during benchmarking — `tsx` processes hang indefinitely after the embedding work completes.

### The Core Problem

The embedding model is **stateless across invocations**. Each hook call pays the full cold-start tax because there is no shared process to hold the model in memory between calls.

## Decision

Introduce a **persistent embedding server** — a long-lived Node.js process that loads the model once at startup and serves embedding requests over a Unix domain socket. Hook scripts connect to this server instead of loading the model themselves.

### Architecture

```
┌──────────────────┐       ┌─────────────────────────────┐
│  retrieve.sh     │──┐    │  embed-server (persistent)   │
│  record.sh       │──┤    │                              │
│  record-tool.sh  │──┼──► │  • Model loaded once at boot │
│  consolidate.sh  │──┘    │  • Listens on socket         │
│  (any future     │  Unix │  • Returns Float32Array      │
│   hook/caller)   │  sock │  • In-memory LRU cache       │
└──────────────────┘       └─────────────────────────────┘
```

### Components

**1. Embedding Server (`scripts/embed-server.ts`)**

- Loads `Xenova/all-MiniLM-L6-v2` once at startup
- Binds the Unix socket **after** model load completes — socket existence implies readiness
- Listens on `.swarm/embed.sock` (project-local, gitignored via explicit entries)
- Exposes three endpoints:
  - `POST /embed` — `{ text: string }` → `{ vector: number[], dims: 384, cached: bool }`. Returns `400 { error: "..." }` if the body is not valid JSON, or if `text` is missing, not a string, or empty.
  - `GET /health` — `{ status: "ok", model: "...", uptime: N, pid: N }`
  - `POST /shutdown` — graceful stop (used by `embed-server:stop` script)
- Handles stale sockets on startup: before `listen()`, attempts `connect()` to any existing socket — if `ECONNREFUSED`, unlinks the stale socket and proceeds; if connection succeeds, another instance is live — exit silently
- Handles concurrent startup: if `server.listen()` gets `EADDRINUSE` after the probe (race with another starter), exit silently
- Maintains the existing in-memory LRU cache (1000 entries, TTL from config)
- Self-exits after 30 minutes with no requests (idle timeout) — unlinks socket on exit
- Graceful shutdown on `SIGTERM`/`SIGINT` — clears LRU cache timers (prevents event loop hang), removes socket file and PID file
- Writes PID to `.swarm/embed.pid` on startup; removes on exit
- Sets `FORCE_TRANSFORMERS=1` in its own environment before importing `@xenova/transformers` (same npx-detection bypass as `bootstrap.ts`)
- Replicates the WASM backend config from `embeddings.ts` before loading the pipeline: `env.backends.onnx.wasm.proxy = false` and `env.backends.onnx.wasm.numThreads = 1` (without these, the ONNX runtime throws "DefaultLogger not registered" errors)
- **Must call the `pipeline()` function directly** — never import or call `computeEmbedding()`, which would try to connect back to the server (recursion)
- Logs to `.swarm/embed-server.log` (errors + startup/shutdown only). Log rotation: before each write, `stat` the file — if ≥1MB, rename to `.log.1` (overwriting any previous rotation) and reopen. Simple, no dependencies, bounded at ~2MB worst case

**2. Client in `embeddings.ts`**

Modify `computeEmbedding()` to try the server first, falling back to in-process model load:

```typescript
import http from 'node:http';

async function computeEmbeddingViaServer(text: string): Promise<Float32Array | null> {
  const socketPath = join(process.cwd(), '.swarm/embed.sock');

  return new Promise((resolve) => {
    const body = JSON.stringify({ text });
    const req = http.request(
      { socketPath, path: '/embed', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 2000 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const { vector } = JSON.parse(data);
            resolve(new Float32Array(vector));
          } catch { resolve(null); }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', (err: NodeJS.ErrnoException) => {
      // Stale socket from crashed server — clean it up.
      // ECONNREFUSED returns in ~10ms on Linux (kernel rejects immediately),
      // so this path adds negligible latency before falling back.
      // ECONNREFUSED = stale socket (crashed server), ENOENT = no socket file.
      // Both are fast (~10ms / ~0ms) — no timeout wait.
      if (err.code === 'ECONNREFUSED') {
        try { unlinkSync(socketPath); } catch {}
      }
      resolve(null);
    });
    req.end(body);
  });
}

export async function computeEmbedding(text: string): Promise<Float32Array> {
  // 1. Check in-memory cache
  // 2. Try persistent server (fast path: ~3-5ms)
  // 3. Fall back to in-process model load (slow path: ~255ms)
}
```

**Why `http.request` and not `fetch`:** Node 24's built-in `fetch` (undici) does not support Unix domain sockets. Verified experimentally — `fetch` with `unix:` URL syntax or a `unix` option both fail. `http.request({ socketPath })` is the standard zero-dependency approach and has been stable since Node 0.x. (The bundled `undici.Agent` with `connect: { socketPath }` also works but adds unnecessary abstraction.)

**Stale socket handling:** If the server crashes (SIGKILL, OOM), `.swarm/embed.sock` remains on disk but nothing is listening. Two layers handle this:

1. **Server-side (startup):** The server probes the existing socket with `connect()` before `listen()`. If `ECONNREFUSED`, it unlinks the stale socket and proceeds. This ensures a crashed server doesn't block future startups.
2. **Client-side (request):** `connect()` returns `ECONNREFUSED` in ~10ms (kernel rejects immediately — no timeout wait). The client catches this, unlinks the stale socket, and falls back to in-process. Total penalty: ~10ms once, then subsequent calls see no socket file and skip straight to fallback.

The key property: **zero behavior change if the server isn't running**. The fallback path is identical to today's code.

**3. Lifecycle Management**

The server is started/stopped via Claude Code hooks and a helper script:

| Event | Action |
|---|---|
| First hook invocation | Auto-start server if not running (lazy) |
| Idle timeout (30min) | Server self-exits after no requests for 30 minutes |
| Manual | `npm run embed-server:start` / `npm run embed-server:stop` |

The `retrieve.sh` hook (which runs first on every session prompt) checks if the server is alive and starts it if needed. Subsequent hooks reuse it.

**Auto-start protocol in hooks:**

```bash
SOCK=".swarm/embed.sock"
PID_FILE=".swarm/embed.pid"

if [ ! -S "$SOCK" ]; then
  # No socket — start server in background
  nohup tsx scripts/embed-server.ts >> .swarm/embed-server.log 2>&1 &
  # Poll for readiness (socket appears after model load)
  for i in $(seq 1 20); do  # 20 × 100ms = 2s max wait
    [ -S "$SOCK" ] && break
    sleep 0.1
  done
  # If still no socket after 2s, model load failed or is very slow.
  # Proceed anyway — embeddings.ts falls back to in-process.
fi
```

The 2s timeout covers the ~255ms model load with margin (model already cached in `~/.cache/huggingface/`). **First-run caveat:** if the 23MB model has never been downloaded, the download can take 5-30s depending on network — both the server startup and the in-process fallback will be slow on the very first invocation. Mitigation: `npm run embed-server:start` in a `postinstall` script triggers the download at install time, not at first hook. If the server fails to start (bad model, missing dependency), the hook proceeds and `computeEmbedding()` uses the in-process fallback — no hang.

**Stop mechanism:**

`npm run embed-server:stop` reads `.swarm/embed.pid` and sends `SIGTERM`. Alternatively, it can `POST /shutdown` to the socket. Both are implemented; the PID file is the primary path (works even if the server is hung and not responding to HTTP).

```bash
# embed-server:stop
PID_FILE=".swarm/embed.pid"
if [ -f "$PID_FILE" ]; then
  kill "$(cat "$PID_FILE")" 2>/dev/null
  rm -f "$PID_FILE"
fi
rm -f .swarm/embed.sock
```

**Idle timeout instead of SessionEnd stop:** The server tracks a `lastRequestAt` timestamp and checks it on a periodic timer (every 5min). If 30 minutes pass with no requests, the server unlinks its socket and exits. This is preferable to a `SessionEnd` hook because multiple Claude Code sessions (tabs, restarts) may share the same project directory — killing on session end would force the next session to pay cold-start again. The idle timeout handles multi-session reuse naturally and still cleans up when the project is truly idle.

**Concurrent startup safety:** On startup, the server probes any existing socket with `connect()`. If `ECONNREFUSED`, the socket is stale (crashed server) — unlink it and proceed to `listen()`. If connection succeeds, another instance is live — exit silently. If two starters race past the probe simultaneously, the second `server.listen()` fails with `EADDRINUSE` and exits. This two-step approach (probe-then-bind) prevents the bug where a stale socket blocks all future startups — `EADDRINUSE` alone would cause the server to exit thinking another instance is running when in fact nothing is listening.

In practice, `retrieve.sh` runs synchronously (no `&`), so it completes before Claude invokes any tool that would trigger `record.sh` or `record-tool.sh`. The race window only exists between concurrent background hook invocations, and the probe + `EADDRINUSE` fallback handles it cleanly.

Alternatively, start eagerly in a `SessionStart` hook (currently unused). This ensures the model is warm before the first prompt.

**4. Socket Protocol**

Use Node.js built-in `http.createServer` with `server.listen(socketPath)`. No external dependencies needed. The Unix socket ensures:
- No port conflicts
- No network exposure (local-only by design)
- Fast IPC (~0.1ms overhead vs TCP)
- Automatic cleanup semantics (unlink on close)

### Request/Response Format

```
POST /embed HTTP/1.1
Content-Type: application/json

{"text": "how does authentication work"}

→ 200 OK
{"vector": [0.0234, -0.0567, ...], "dims": 384, "cached": false}
```

Vectors are serialized as JSON number arrays for simplicity. At 384 float32s, this is ~3KB per response — negligible for IPC.

## Alternatives Considered

### A. Keep current approach (do nothing)

- **Pro:** No new complexity
- **Con:** 255ms cold start on every hook; WASM thread hang causes zombie processes
- **Rejected:** The zombie process issue alone warrants a fix

### B. Node.js `worker_threads` with shared model

- **Pro:** Single process, shared memory
- **Con:** Workers share the same event loop constraints; `@xenova/transformers` WASM backend doesn't cleanly share across threads; still requires a coordinator
- **Rejected:** More complex than a simple HTTP server with less isolation

### C. Precompute and cache embeddings in SQLite

- **Pro:** No server needed; embeddings for known texts are already stored in `pattern_embeddings`
- **Con:** Only helps retrieval (comparing stored patterns); doesn't help with embedding the *query* text itself, which is always new; distill creates new text that needs embedding
- **Rejected:** Doesn't solve the core problem (query embedding)

### D. Use a compiled binary embedding tool (e.g., `llama.cpp` with embedding mode)

- **Pro:** Faster startup than WASM; no WASM thread hang issues
- **Con:** New dependency; platform-specific binary; different model format
- **Rejected:** Overkill for current scale; introduces build complexity

### E. Use Node.js `--import` preload to keep model warm

- **Pro:** No server needed
- **Con:** `tsx` spawns fresh processes per invocation; `--import` still loads per-process; doesn't actually persist across hook invocations
- **Rejected:** Doesn't solve the cross-process persistence problem

## Consequences

### Positive

- **~85x faster embedding inference:** 3ms (server) vs 255ms (cold load) for the embedding computation itself. End-to-end hook latency improves from ~500ms to ~200ms (2.5x) because tsx startup + bootstrap (~200ms) is unchanged — that's a separate concern addressed later by the MCP server (which eliminates the tsx overhead entirely by being a long-lived process itself). The two optimizations are complementary, not redundant.
- **Eliminates zombie processes:** The model lives in one well-managed process instead of N hanging tsx processes
- **Lower total memory:** One model instance (~50MB RSS) shared, instead of potentially multiple concurrent instances when hooks overlap
- **Zero-downside fallback:** If the server is down, behavior is identical to today. Stale socket detection adds ~10ms once (not the 2000ms timeout — `ECONNREFUSED` is immediate on Linux).
- **Enables future optimizations:** Batch embedding, connection pooling, model prewarming

### Negative

- **New background process to manage:** Server must be started/stopped; socket file must be cleaned up
- **New failure mode:** Server crash leaves a stale socket (handled by `ECONNREFUSED` auto-unlink). Server hang requires the 2000ms request timeout to expire before fallback kicks in — the client's `req.on('timeout', () => req.destroy())` ensures the request is aborted and doesn't hang indefinitely.
- **Slightly more complex `embeddings.ts`:** Server-first + fallback adds ~30 lines

### Neutral

- No new npm dependencies (uses Node.js `http` module)
- `.swarm/` is tracked in git (config, schema). Runtime files (`embed.sock`, `embed.pid`, `embed-server.log`) need explicit `.gitignore` entries.
- Config values (`cache_ttl_seconds`, LRU size) are shared between server and client via existing `config.ts`
- Model version is effectively pinned: `config.ts` hardcodes `'Xenova/all-MiniLM-L6-v2'` and `@xenova/transformers` is locked via `node_modules`. Server and fallback always use the same library from the same install, so vectors are identical. A mismatch could only occur if the server was left running across an `npm update` — restarting the server after dependency changes is sufficient.
- Concurrent WASM inference is serialized: `numThreads = 1` means simultaneous requests queue at the model level. Under concurrent load (e.g., rapid `record.sh` + `record-tool.sh` overlap), individual request latency is `~3ms × queue_depth`, not flat `~3ms`. Still far better than N cold starts.
- Idle timeout precision: the 5-minute check interval means the server can linger up to ~35 minutes idle in the worst case. Acceptable for a background process using ~50MB RSS.

## Implementation Plan

### Phase 1: Server + Client (core)

1. Create `scripts/embed-server.ts` — HTTP server on Unix socket with WASM config (`proxy = false`, `numThreads = 1`), 30min idle timeout, PID file, `FORCE_TRANSFORMERS=1`, log rotation, `/shutdown` endpoint, error responses for bad requests and malformed JSON, timer cleanup on shutdown
2. Modify `src/reasoningbank/utils/embeddings.ts` — add server-first path in `computeEmbedding()` with `req.on('timeout', () => req.destroy())`
3. Add `npm run embed-server:start`, `npm run embed-server:stop` (PID-based kill + socket cleanup), and `postinstall: npm run embed-server:stop` to `package.json`
4. Add `.swarm/embed.sock`, `.swarm/embed.pid`, `.swarm/embed-server.log*` to `.gitignore`

### Phase 2: Hook Integration

5. Modify `retrieve.sh` — auto-start server if socket missing, poll for readiness (100ms × 20 = 2s max)
6. (Optional) Add `SessionStart` hook for eager model warmup (also pre-downloads model on first install)

### Phase 3: Robustness

7. Add server startup timeout (fail fast if model can't load)
8. Tests: verify fallback works when server is absent; verify server returns correct vectors; verify stale socket auto-cleanup; verify probe-then-bind startup handles stale sockets
9. (Optional) Add `POST /embed-batch` endpoint for consolidation — current `computeEmbeddingBatch()` is `Promise.all(map)` with no real batching, and consolidation runs in background at `SessionEnd`, so single `/embed` calls are sufficient for now

### Estimated Effort

~2-3 hours for Phase 1+2. Phase 3 can be deferred.

## Validation

After implementation, the benchmark should show:

| Scenario | Before | After |
|---|---|---|
| `retrieve.sh` hook latency | ~500ms (tsx + bootstrap + model + inference) | ~200ms (tsx + bootstrap + server round-trip) |
| `record.sh` / `record-tool.sh` per-invocation | ~500ms (same) | ~200ms (same pattern) |
| Embedding inference | ~255ms (cold) / ~3ms (warm) | ~5ms (server round-trip) / <1ms (client cache) |
| Concurrent inference (N overlapping hooks) | N × ~255ms cold starts | ~3ms × N serialized (WASM single-threaded) |
| Zombie tsx processes | Yes (WASM threads hang) | No (model in dedicated server) |

The tsx + bootstrap overhead (~200ms) remains — that's a separate concern (could be addressed later by keeping `run.ts` as a long-lived process too, or switching from tsx to a pre-compiled runner).

## Resolved Uncertainties

Investigated 2026-03-03. Each item was verified experimentally on this machine (Node v24.13.1, Linux 6.8.0).

### 1. `fetch` does not support Unix sockets on Node 24

Node's built-in `fetch` (undici) fails with Unix domain sockets — both `http://unix:/path:/route` syntax and a `unix` option property. Two working alternatives, both zero-dependency:

| Approach | Works | Notes |
|---|---|---|
| `http.request({ socketPath })` | Yes | Stable since Node 0.x. Chosen for the client. |
| `new undici.Agent({ connect: { socketPath } })` | Yes | Bundled with Node 24 via `require('undici')`. Unnecessary abstraction for this use case. |
| `fetch('http://unix:...')` | **No** | Fails with "fetch failed". |

Decision: Use `http.request` with `socketPath`. Simplest, most stable, no abstraction layer.

### 2. Race condition on concurrent server startup

Two hooks could attempt to start the server simultaneously. Analysis of the hook architecture:

- `retrieve.sh` runs **synchronously** (no `&`) — it blocks until complete. One invocation per prompt.
- `record.sh` runs in **background** (`&` + `disown`) — multiple can overlap across rapid Bash tool uses.
- `record-tool.sh` runs in **background** (`&` + `disown`) — same pattern as `record.sh`, fires on Edit/Write/Agent.
- `consolidate.sh` runs in **background** — once per session.

The realistic race: two `record.sh`/`record-tool.sh` invocations both see no socket and both try to start the server. Resolution is two-layered:

1. **Probe before bind:** On startup, the server `connect()`s to any existing socket. `ECONNREFUSED` → stale, unlink it. Success → another instance is live, exit. This handles the crashed-server case where the socket file exists but nothing is listening — plain `EADDRINUSE` would incorrectly exit thinking another instance was running.
2. **`EADDRINUSE` as fallback:** If two starters race past the probe, the second `server.listen()` gets `EADDRINUSE` and exits silently. The socket bind is still the final mutex — the probe just handles the stale-socket case that `EADDRINUSE` alone gets wrong.

### 3. Stale socket penalty is ~10ms, not 2000ms

When the server crashes (SIGKILL, OOM), the `.swarm/embed.sock` file persists on disk but nothing is listening. Measured behavior:

```
connect() to stale Unix socket → ECONNREFUSED in ~10ms
```

The Linux kernel rejects the connection immediately — it does not wait for the 2000ms request timeout. The client catches `ECONNREFUSED`, unlinks the stale socket, and falls back to in-process model load. Total added latency: **~10ms once**, then subsequent calls see no socket file and skip straight to fallback (~0ms overhead).

The 2000ms timeout only triggers if the server is running but **hung** (accepting connections but never responding). This is the true worst case.

### 4. End-to-end vs inference speedup

The ~85x improvement (255ms → 3ms) applies to the **embedding inference portion only**. The full hook invocation chain is:

```
tsx startup (~200ms) → bootstrap (~50ms) → embedding inference (255ms → ~5ms) → rest of pipeline
```

End-to-end hook latency improves from ~500ms to ~200ms — a **2.5x** improvement. The tsx + bootstrap overhead dominates in the "after" case. This is addressed separately by the MCP server: once hooks run through the MCP server (a long-lived process), there is no tsx spawn at all. The embed-server solves the embedding cold-start now; the MCP server eliminates the tsx overhead later. Complementary optimizations.

### 5. Model version is effectively pinned

- Model identifier `'Xenova/all-MiniLM-L6-v2'` is hardcoded in `config.ts` `DEFAULT_CONFIG` and in `reasoningbank.yaml`.
- `@xenova/transformers` version is locked in `package-lock.json` via `^2.17.2`.
- The model binary is cached on first download (typically `~/.cache/huggingface/`).
- Server and in-process fallback use the **same** library from the **same** `node_modules`, so their output vectors are identical.
- The only mismatch scenario: server left running across an `npm update` that changes `@xenova/transformers`. Fix: restart the server after dependency updates. No version-checking protocol needed.

### 6. Batch endpoint deferred

`computeEmbeddingBatch()` in `embeddings.ts` is `Promise.all(texts.map(text => computeEmbedding(text)))` — no actual batching at the model level. The primary consumer would be `consolidate.ts` (dedup comparisons), which runs in the background at `SessionEnd` with a 10s timeout. Serial `/embed` calls through the server (~5ms each) are fast enough. Batch endpoint moved to Phase 3 as optional.
