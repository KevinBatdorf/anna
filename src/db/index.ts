import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';

const DB_PATH = process.env.DB_PATH || '/data/db/anna.db';

const sqlite = new Database(DB_PATH, { readonly: true });
sqlite.run('PRAGMA cache_size = -32000');

export const db = drizzle(sqlite, { schema });
export const raw = sqlite;
