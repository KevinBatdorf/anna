import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { describe, expect, it } from 'vitest';

describe('goodreads_vec KNN search', () => {
	it('returns closest vectors by cosine distance', () => {
		const db = new Database(':memory:');
		sqliteVec.load(db);

		db.run(`CREATE VIRTUAL TABLE goodreads_vec USING vec0(
      goodreads_id INTEGER PRIMARY KEY,
      embedding FLOAT[3] DISTANCE_METRIC=cosine
    )`);

		const insert = db.prepare(
			'INSERT INTO goodreads_vec (goodreads_id, embedding) VALUES (?, ?)',
		);
		insert.run(1, new Float32Array([1, 0, 0]));
		insert.run(2, new Float32Array([0, 1, 0]));
		insert.run(3, new Float32Array([0.9, 0.1, 0]));

		const results = db
			.prepare(
				`SELECT goodreads_id, distance FROM goodreads_vec
       WHERE embedding MATCH ? ORDER BY distance LIMIT 3`,
			)
			.all(new Float32Array([1, 0, 0])) as Array<{
			goodreads_id: number;
			distance: number;
		}>;

		expect(results).toHaveLength(3);
		expect(results[0].goodreads_id).toBe(1);
		expect(results[1].goodreads_id).toBe(3);
		expect(results[2].goodreads_id).toBe(2);
	});

	it('returns empty results for empty table', () => {
		const db = new Database(':memory:');
		sqliteVec.load(db);

		db.run(`CREATE VIRTUAL TABLE goodreads_vec USING vec0(
      goodreads_id INTEGER PRIMARY KEY,
      embedding FLOAT[3] DISTANCE_METRIC=cosine
    )`);

		const results = db
			.prepare(
				`SELECT goodreads_id, distance FROM goodreads_vec
       WHERE embedding MATCH ? ORDER BY distance LIMIT 5`,
			)
			.all(new Float32Array([1, 0, 0])) as Array<{
			goodreads_id: number;
			distance: number;
		}>;

		expect(results).toHaveLength(0);
	});
});
