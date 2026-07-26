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

// Shared 20-column INSERT column list and default values for ranked_session
// rows inserted by test helpers. Both the bound-parameter insertRankedSession
// and the escaped-interpolation trigger SQL in installRankedAfterStaleDelete
// build from this definition so the two paths cannot diverge.
const RANKED_SESSION_INSERT_COLUMNS = `id, userId, startRequestId, startPayloadHash, activeUserId,
	gameType, rulesetVersion, configJson, configHash, seed, seedCommitment,
	actionLogJson, actionLogHash, nextSequence, initialWager, committedWager,
	status, expiresAt, createdAt, updatedAt` as const;

interface RankedSessionInsertDefaults {
	startPayloadHash: string;
	gameType: string;
	rulesetVersion: string;
	configJson: string;
	configHash: string;
	seed: string;
	seedCommitment: string;
	actionLogJson: string;
	actionLogHash: string;
	nextSequence: number;
	initialWager: number;
	committedWager: number;
}

const RANKED_SESSION_INSERT_DEFAULTS: RankedSessionInsertDefaults = {
	startPayloadHash: 'start-hash',
	gameType: 'blackjack',
	rulesetVersion: 'blackjack-ranked-v1',
	configJson: '{}',
	configHash: 'config-hash',
	seed: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
	seedCommitment: 'seed-commitment',
	actionLogJson: '[]',
	actionLogHash: 'action-log-hash',
	nextSequence: 0,
	initialWager: 10,
	committedWager: 10,
};

export async function insertRankedSession(
	db: D1Database,
	input: InsertRankedSessionInput,
): Promise<void> {
	const now = Math.trunc(Date.now() / 1000);
	const status = input.status ?? (input.activeUserId === null ? 'settled' : 'active');
	const d = RANKED_SESSION_INSERT_DEFAULTS;
	await db
		.prepare(
			`INSERT INTO ranked_session (${RANKED_SESSION_INSERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.id,
			input.userId,
			input.startRequestId,
			d.startPayloadHash,
			input.activeUserId,
			d.gameType,
			d.rulesetVersion,
			d.configJson,
			d.configHash,
			d.seed,
			d.seedCommitment,
			d.actionLogJson,
			d.actionLogHash,
			d.nextSequence,
			input.initialWager ?? d.initialWager,
			input.committedWager ?? d.committedWager,
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
	const esc = (value: string) => value.replace(/'/g, "''");
	const d = RANKED_SESSION_INSERT_DEFAULTS;
	const sql = `CREATE TRIGGER ${triggerName}
		AFTER DELETE ON mp_membership
		WHEN OLD.userId = '${esc(input.userId)}' AND OLD.roomCode = '${esc(input.roomCode)}'
		BEGIN
			INSERT INTO ranked_session (${RANKED_SESSION_INSERT_COLUMNS}) VALUES (
				'${esc(input.sessionId)}', '${esc(input.userId)}', '${esc(input.startRequestId)}', '${d.startPayloadHash}', '${esc(input.userId)}',
				'${d.gameType}', '${d.rulesetVersion}', '${d.configJson}', '${d.configHash}',
				'${d.seed}', '${d.seedCommitment}',
				'${d.actionLogJson}', '${d.actionLogHash}', ${d.nextSequence}, ${d.initialWager}, ${d.committedWager}, 'active', ${now + 900}, ${now}, ${now}
			);
		END`;
	await db.prepare(sql).run();
}
