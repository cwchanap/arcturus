import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Miniflare } from 'miniflare';

const migrationFiles = readdirSync(join(process.cwd(), 'drizzle'))
	.filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
	.sort();

export async function createRankedTestD1(): Promise<{ mf: Miniflare; db: D1Database }> {
	const mf = new Miniflare({
		modules: [
			{
				type: 'ESModule',
				path: 'file:///entry.js',
				contents: 'export default { fetch() { return new Response("ok"); } }',
			},
		],
		d1Databases: { DB: `ranked-${crypto.randomUUID()}` },
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

export async function insertRankedTestUser(
	db: D1Database,
	overrides: Partial<{ id: string; name: string; email: string; chipBalance: number }> = {},
): Promise<void> {
	const now = Math.trunc(Date.now() / 1000);
	const id = overrides.id ?? crypto.randomUUID();
	await db
		.prepare(
			'INSERT INTO user (id, name, email, emailVerified, chipBalance, heldChips, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
		)
		.bind(
			id,
			overrides.name ?? `Test ${id}`,
			overrides.email ?? `${id}@test.local`,
			0,
			overrides.chipBalance ?? 10000,
			0,
			now,
			now,
		)
		.run();
}

export interface InsertRankedSessionInput {
	id: string;
	userId: string;
	startRequestId: string;
	activeUserId: string | null;
	status?: string;
	initialWager?: number;
	committedWager?: number;
}

export async function insertRankedSession(
	db: D1Database,
	input: InsertRankedSessionInput,
): Promise<void> {
	const now = Math.trunc(Date.now() / 1000);
	const status = input.status ?? (input.activeUserId === null ? 'settled' : 'active');
	await db
		.prepare(
			`INSERT INTO ranked_session (
				id, userId, startRequestId, startPayloadHash, activeUserId,
				gameType, rulesetVersion, configJson, configHash, seed, seedCommitment,
				actionLogJson, actionLogHash, nextSequence, initialWager, committedWager,
				status, expiresAt, createdAt, updatedAt
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.userId,
			input.startRequestId,
			'start-hash',
			input.activeUserId,
			'blackjack',
			'blackjack-ranked-v1',
			'{}',
			'config-hash',
			'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
			'seed-commitment',
			'[]',
			'action-log-hash',
			0,
			input.initialWager ?? 10,
			input.committedWager ?? 10,
			status,
			now + 900,
			now,
			now,
		)
		.run();
}

export interface InstallRankedAfterStaleDeleteInput {
	userId: string;
	roomCode: string;
	sessionId: string;
	startRequestId: string;
	triggerName?: string;
}

export async function installRankedAfterStaleDelete(
	db: D1Database,
	input: InstallRankedAfterStaleDeleteInput,
): Promise<void> {
	const now = Math.trunc(Date.now() / 1000);
	const triggerName = input.triggerName ?? 'ranked_after_stale_delete';
	// SQLite triggers cannot use bound parameters (?), so values are
	// interpolated directly. This is test-only code with controlled inputs.
	const sql = `CREATE TRIGGER ${triggerName}
		AFTER DELETE ON mp_membership
		WHEN OLD.userId = '${input.userId.replace(/'/g, "''")}' AND OLD.roomCode = '${input.roomCode.replace(/'/g, "''")}'
		BEGIN
			INSERT INTO ranked_session (
				id, userId, startRequestId, startPayloadHash, activeUserId,
				gameType, rulesetVersion, configJson, configHash, seed, seedCommitment,
				actionLogJson, actionLogHash, nextSequence, initialWager, committedWager,
				status, expiresAt, createdAt, updatedAt
			) VALUES (
				'${input.sessionId.replace(/'/g, "''")}', '${input.userId.replace(/'/g, "''")}', '${input.startRequestId.replace(/'/g, "''")}', 'start-hash', '${input.userId.replace(/'/g, "''")}',
				'blackjack', 'blackjack-ranked-v1', '{}', 'config-hash',
				'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'seed-commitment',
				'[]', 'action-log-hash', 0, 10, 10, 'active', ${now + 900}, ${now}, ${now}
			);
		END`;
	await db.prepare(sql).run();
}
