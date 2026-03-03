#!/usr/bin/env node
// Query the research DB (read-only) from the snoo-flow-v0.1 repo.
// Usage: node scripts/research-query.js "SELECT * FROM open_findings WHERE severity='CRITICAL' LIMIT 5"

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DB_PATH = '/home/snoozyy/ruvnet-research/db/research.db';
const db = new Database(DB_PATH, { readonly: true });

const sql = process.argv.slice(2).join(' ');
if (!sql) {
  console.error('Usage: node scripts/research-query.js "<SQL>"');
  console.error('Example: node scripts/research-query.js "SELECT * FROM open_findings WHERE severity=\'CRITICAL\' LIMIT 5"');
  process.exit(1);
}

try {
  const rows = db.prepare(sql).all();
  console.log(JSON.stringify(rows, null, 2));
} catch (e) {
  console.error('Query error:', e.message);
  process.exit(1);
} finally {
  db.close();
}
