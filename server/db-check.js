// Quick connection + schema check for the game-records database.
// Usage:  set DATABASE_URL, then:  npm run db:check
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* none */ }

import { dbEnabled, initDb, stats } from './db.js';

if (!dbEnabled()) {
  console.log('DATABASE_URL is not set. Set it (or add a .env file) and try again.');
  process.exit(1);
}
await initDb();
const s = await stats();
console.log('Connected. Current stats:', JSON.stringify(s, null, 2));
process.exit(0);
