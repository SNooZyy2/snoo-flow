- MCP SERVER -> Ersetzt perma warm embeddings?
- NAPI BRIDGE

The PID file is unnecessary. You mention .swarm/embed-server.pid in the components section, but your startup logic already uses EADDRINUSE as the mutex. The PID file adds a second source of truth that can go stale. You'd only need it for embed-server:stop — but you can also stop by connecting to the socket and sending a shutdown command, or just kill $(lsof -t .swarm/embed.sock). I'd drop the PID file unless you find a concrete need.

The 200ms tsx+bootstrap floor. You correctly identify this as a separate concern, but it's worth noting: once you build the MCP server, the hooks won't need tsx scripts/run.ts at all — the MCP server is the long-lived process. So the embed-server solves the embedding cold-start now, and the MCP server will eventually eliminate the tsx overhead too. They're complementary, not redundant.

SessionEnd stop might be premature. If you're running multiple Claude Code sessions against the same project (tabs, restarts), killing the embed server on session end means the next session pays cold-start again. Consider letting it idle-timeout instead (e.g., auto-exit after 30min with no requests). Low priority — easy to change later.