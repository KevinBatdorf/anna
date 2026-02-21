import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const DATABASE_URL =
	process.env.DATABASE_URL || 'postgres://anna:anna@localhost:5432/anna';

export const sql = postgres(DATABASE_URL, { max: 20 });
/** Alias for routes that use raw tagged-template queries */
export const raw = sql;
export const db = drizzle(sql, { schema });
