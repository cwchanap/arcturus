import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Miniflare } from 'miniflare';

const migrationFiles = readdirSync(join(process.cwd(), 'drizzle'))
	.filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
	.sort();

export async function createBlackjackRunTestD1(): Promise<{ mf: Miniflare; db: D1Database }> {
	const mf = new Miniflare({
		modules: [
			{
				type: 'ESModule',
				path: 'file:///entry.js',
				contents: 'export default { fetch() { return new Response("ok"); } }',
			},
		],
		d1Databases: { DB: `blackjack-run-${crypto.randomUUID()}` },
		d1Persist: false,
	});
	await mf.ready;
	const db = await mf.getD1Database('DB');
	for (const file of migrationFiles) {
		const sql = readFileSync(join(process.cwd(), 'drizzle', file), 'utf8');
		const statements = sql
			.split('--> statement-breakpoint')
			.map((statement) => statement.trim())
			.filter(Boolean);
		await db.batch(statements.map((statement) => db.prepare(statement)));
	}
	return { mf, db };
}

export async function insertTestUser(
	db: D1Database,
	overrides: Partial<{ id: string; name: string; email: string; chipBalance: number }> = {},
): Promise<void> {
	const now = Math.trunc(Date.now() / 1000);
	const id = overrides.id ?? crypto.randomUUID();
	await db
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, chipBalance, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
		)
		.bind(
			id,
			overrides.name ?? `Test ${id}`,
			overrides.email ?? `${id}@test.local`,
			0,
			overrides.chipBalance ?? 10000,
			now,
			now,
		)
		.run();
}
