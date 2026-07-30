import { Database as SQLiteDatabase } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import type { Database } from '../db';
import { getBulkUserWinsRanks } from './game-stats-repository';

function applyCheckedInMigrations(sqlite: SQLiteDatabase): void {
	const migrationDir = join(process.cwd(), 'drizzle');
	const files = readdirSync(migrationDir)
		.filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
		.sort();
	for (const file of files) {
		const source = readFileSync(join(migrationDir, file), 'utf8');
		for (const statement of source.split('--> statement-breakpoint')) {
			const sql = statement.trim();
			if (sql.length > 0) sqlite.run(sql);
		}
	}
}

function seedUser(sqlite: SQLiteDatabase, id: string): void {
	sqlite.run(
		`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[id, id, `${id}@example.test`, 0, 1, 1],
	);
}

function seedGameStats(
	sqlite: SQLiteDatabase,
	userId: string,
	gameType: string,
	totalWins: number,
	handsPlayed: number,
): void {
	sqlite.run(
		`INSERT INTO game_stats (userId, gameType, totalWins, totalLosses, handsPlayed, biggestWin, netProfit, updatedAt)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[userId, gameType, totalWins, 0, handsPlayed, 0, 0, 1],
	);
}

function createDatabase(): { sqlite: SQLiteDatabase; db: Database } {
	const sqlite = new SQLiteDatabase(':memory:');
	applyCheckedInMigrations(sqlite);
	return { sqlite, db: drizzle(sqlite) as unknown as Database };
}

describe('getBulkUserWinsRanks (SQLite)', () => {
	test('preserves wins leaderboard ordering and only returns played subject games', async () => {
		const { sqlite, db } = createDatabase();
		try {
			for (const userId of [
				'target',
				'a-equal-wins',
				'legacy-zero-hand-higher',
				'lower-wins',
				'active-zero-wins',
				'poker-higher',
			]) {
				seedUser(sqlite, userId);
			}

			seedGameStats(sqlite, 'target', 'blackjack', 4, 10);
			seedGameStats(sqlite, 'target', 'poker', 2, 8);
			seedGameStats(sqlite, 'target', 'roulette', 9, 0);
			seedGameStats(sqlite, 'a-equal-wins', 'blackjack', 4, 8);
			seedGameStats(sqlite, 'legacy-zero-hand-higher', 'blackjack', 5, 0);
			seedGameStats(sqlite, 'lower-wins', 'blackjack', 3, 6);
			seedGameStats(sqlite, 'active-zero-wins', 'blackjack', 0, 4);
			seedGameStats(sqlite, 'poker-higher', 'poker', 3, 5);

			expect(await getBulkUserWinsRanks(db, 'target')).toEqual(
				new Map([
					['blackjack', 3],
					['poker', 2],
				]),
			);
		} finally {
			sqlite.close();
		}
	});

	test('returns no ranks when the user has no game-stat rows', async () => {
		const { sqlite, db } = createDatabase();
		try {
			seedUser(sqlite, 'missing-subject');

			expect(await getBulkUserWinsRanks(db, 'missing-subject')).toEqual(new Map());
		} finally {
			sqlite.close();
		}
	});
});
