import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';

const DB_PATH = process.env.DB_PATH || '/data/db/anna.db';

const sqlite = new Database(DB_PATH, { readonly: true });
sqlite.run('PRAGMA journal_mode = WAL');
sqlite.run('PRAGMA busy_timeout = 5000');
sqlite.run('PRAGMA mmap_size = 4294967296');
sqlite.run('PRAGMA cache_size = -64000');

export const db = drizzle(sqlite, { schema });
export const raw = sqlite;
export { DB_PATH };
