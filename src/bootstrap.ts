/**
 * snoo-flow v0.1 bootstrap
 * Initialize DB schema and embedding model.
 */

import { runMigrations } from './reasoningbank/db/queries.js';

export async function bootstrap(): Promise<void> {
  // Force real embeddings (not hash-based)
  process.env.FORCE_TRANSFORMERS = '1';

  // Create .swarm/memory.db with schema
  await runMigrations();

  console.log('[snoo-flow] Bootstrap complete');
}

// Run directly if called as script
const isMain = process.argv[1]?.endsWith('bootstrap.js') ||
               process.argv[1]?.endsWith('bootstrap.ts');
if (isMain) {
  bootstrap().catch(err => {
    console.error('Bootstrap failed:', err);
    process.exit(1);
  });
}
