import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import { createBlackjackRunTestD1, insertTestUser } from './test-d1';
import {
	BLACKJACK_RUN_EXPIRATION_PAGE_SIZE,
	createBlackjackRunRepository,
	type BlackjackRunRepository,
	type CreateDailyRunInput,
	type CreateRankedRunWithStakeInput,
} from './repository';

const USER_ID = 'blackjack-run-repository-user';
const NOW_SECONDS = 1_800_000_000;
const SEED_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const SEED_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

// Real-time unix seconds for expiry-CAS tests. The command append SQL uses
// expiresAt > unixepoch() (DB time), so tests that exercise the expiry guard
// must set expiresAt relative to the real clock, not the fixed NOW_SECONDS
// constant (which is in 2027 and therefore always in the future).
function realNowSeconds(): number {
	return Math.trunc(Date.now() / 1000);
}

let mf: Miniflare;
let db: D1Database;
let repository: BlackjackRunRepository;

beforeAll(async () => {
	({ mf, db } = await createBlackjackRunTestD1());
	repository = createBlackjackRunRepository(db);
});

afterAll(async () => {
	await mf.dispose();
});

beforeEach(async () => {
	await db.batch([
		db.prepare('DELETE FROM blackjack_run'),
		db.prepare('DELETE FROM blackjack_daily'),
		db.prepare('DELETE FROM user'),
	]);
	await insertTestUser(db, { id: USER_ID, chipBalance: 1000 });
});

function runId(sequence: number): string {
	return `run-${String(sequence).padStart(18, '0')}`;
}

function rankedStartInput(
	overrides: Partial<CreateRankedRunWithStakeInput> = {},
): CreateRankedRunWithStakeInput {
	return {
		userId: USER_ID,
		id: runId(1),
		startRequestId: 'request-ranked-000001',
		initialWager: 100,
		seed: SEED_A,
		expiresAt: NOW_SECONDS + 900,
		createdAt: NOW_SECONDS,
		updatedAt: NOW_SECONDS,
		...overrides,
	};
}

function dailyStartInput(overrides: Partial<CreateDailyRunInput> = {}): CreateDailyRunInput {
	const id = overrides.id ?? runId(7);
	return {
		userId: USER_ID,
		id,
		periodKey: '2026-10-11',
		startRequestId: `request-${id}`,
		seed: SEED_B,
		expiresAt: NOW_SECONDS + 1800,
		createdAt: NOW_SECONDS,
		updatedAt: NOW_SECONDS,
		...overrides,
	};
}

async function completeDailyRun(input: {
	userId: string;
	runSequence: number;
	periodKey: string;
	endingBankroll: number;
	roundsCompleted: number;
	settledAt: number;
}): Promise<void> {
	const id = runId(input.runSequence);
	expect(
		await repository.createDailyRun(
			dailyStartInput({
				userId: input.userId,
				id,
				periodKey: input.periodKey,
				startRequestId: `request-${id}`,
			}),
		),
	).toEqual({ kind: 'created' });

	expect(
		await repository.finishRun({
			userId: input.userId,
			runId: id,
			mode: 'daily',
			expectedSequence: 0,
			status: 'completed',
			resultJson: '{}',
			dailyEndingBankroll: input.endingBankroll,
			dailyRoundsCompleted: input.roundsCompleted,
			nowSeconds: input.settledAt,
		}),
	).toEqual({ kind: 'applied' });
}

async function readBalance(userId: string = USER_ID): Promise<{ chipBalance: number }> {
	const row = await db
		.prepare('SELECT chipBalance FROM user WHERE id = ?')
		.bind(userId)
		.first<{ chipBalance: number }>();
	if (!row) throw new Error('missing test user');
	return row;
}

// Direct row inserter for repository test setup (expiration paging, raw-state
// fixtures). Modeled on insertTestUser/insertRankedSession in
// ../ranked/test-d1.
async function insertBlackjackRunRow(
	db: D1Database,
	input: {
		id: string;
		userId: string;
		expiresAt: number;
		status?: string;
		mode?: string;
		activeUserId?: string | null;
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO blackjack_run (
				id, userId, activeUserId, mode, periodKey, startRequestId, initialWager,
				seed, commandsJson, nextSequence, status, resultJson,
				dailyEndingBankroll, dailyRoundsCompleted, expiresAt, createdAt, updatedAt, settledAt
			)
			VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, '[]', 0, ?, NULL, NULL, NULL, ?, ?, ?, NULL)`,
		)
		.bind(
			input.id,
			input.userId,
			input.activeUserId ?? null,
			input.mode ?? 'ranked',
			`start-${input.id}`,
			'seed',
			input.status ?? 'active',
			input.expiresAt,
			NOW_SECONDS,
			NOW_SECONDS,
		)
		.run();
}

describe('ranked run start with stake', () => {
	test('applies the run row and the initial wager debit atomically', async () => {
		const result = await repository.createRankedRunWithStake(rankedStartInput());
		expect(result).toEqual({ kind: 'applied' });

		expect(await readBalance()).toEqual({ chipBalance: 900 });

		const run = await repository.findActiveRun(USER_ID, 'ranked');
		expect(run).not.toBeNull();
		expect(run!.id).toBe(runId(1));
		expect(run!.userId).toBe(USER_ID);
		expect(run!.activeUserId).toBe(USER_ID);
		expect(run!.mode).toBe('ranked');
		expect(run!.status).toBe('active');
		expect(run!.periodKey).toBeNull();
		expect(run!.initialWager).toBe(100);
		expect(run!.nextSequence).toBe(0);
		expect(run!.commands).toEqual([]);
		expect(run!.resultJson).toBeNull();
		expect(run!.dailyEndingBankroll).toBeNull();
		expect(run!.dailyRoundsCompleted).toBeNull();
		expect(run!.settledAt).toBeNull();
		expect(run!.expiresAt).toBe(NOW_SECONDS + 900);
	});

	test('insufficient or raced initial stake leaves no run and no balance mutation', async () => {
		await insertTestUser(db, { id: 'low-balance-user', chipBalance: 50 });
		const insufficient = await repository.createRankedRunWithStake(
			rankedStartInput({ userId: 'low-balance-user', id: runId(2), initialWager: 100 }),
		);
		expect(insufficient).toEqual({ kind: 'insufficient' });
		expect(await readBalance('low-balance-user')).toEqual({ chipBalance: 50 });
		expect(await repository.findOwnedRun('low-balance-user', runId(2))).toBeNull();

		// Raced: an active run already exists for this user, so the second
		// start must not insert a row or move chips.
		await repository.createRankedRunWithStake(rankedStartInput({ id: runId(3) }));
		const raced = await repository.createRankedRunWithStake(
			rankedStartInput({ id: runId(4), startRequestId: 'request-ranked-000002' }),
		);
		expect(raced).toEqual({ kind: 'active-exists' });
		expect(await readBalance()).toEqual({ chipBalance: 900 });
		expect(await repository.findOwnedRun(USER_ID, runId(4))).toBeNull();
	});

	test('start request id is unique and is debited exactly once', async () => {
		const first = await repository.createRankedRunWithStake(rankedStartInput());
		expect(first).toEqual({ kind: 'applied' });

		const duplicate = await repository.createRankedRunWithStake(
			rankedStartInput({ id: runId(5), startRequestId: 'request-ranked-000001' }),
		);
		expect(duplicate).toEqual({ kind: 'duplicate-request' });

		expect(await readBalance()).toEqual({ chipBalance: 900 });
		const original = await repository.findByStartRequest(USER_ID, 'request-ranked-000001');
		expect(original?.id).toBe(runId(1));
		expect(await repository.findOwnedRun(USER_ID, runId(5))).toBeNull();
	});

	test('one active run per (userId, mode) while Ranked and Daily coexist', async () => {
		await repository.createRankedRunWithStake(rankedStartInput());
		const secondRanked = await repository.createRankedRunWithStake(
			rankedStartInput({ id: runId(6), startRequestId: 'request-ranked-000002' }),
		);
		expect(secondRanked).toEqual({ kind: 'active-exists' });

		// A Daily run for the same user coexists with the active Ranked run.
		expect(await repository.createDailyRun(dailyStartInput())).toEqual({ kind: 'created' });
		expect(
			await repository.createDailyRun(dailyStartInput({ id: runId(8), periodKey: '2026-10-12' })),
		).toEqual({ kind: 'created' });

		expect((await repository.findActiveRun(USER_ID, 'ranked'))?.id).toBe(runId(1));
		expect((await repository.findDailyRun(USER_ID, '2026-10-11'))?.id).toBe(runId(7));
		expect((await repository.findDailyRun(USER_ID, '2026-10-12'))?.id).toBe(runId(8));
	});

	test('daily allows exactly one run per user per period', async () => {
		expect(await repository.createDailyRun(dailyStartInput())).toEqual({ kind: 'created' });
		expect(await repository.createDailyRun(dailyStartInput({ id: runId(9) }))).toEqual({
			kind: 'existing',
		});
		expect(
			await repository.createDailyRun(dailyStartInput({ id: runId(10), periodKey: '2026-10-12' })),
		).toEqual({ kind: 'created' });

		await insertTestUser(db, { id: 'daily-user-2', chipBalance: 500 });
		expect(
			await repository.createDailyRun(
				dailyStartInput({ userId: 'daily-user-2', id: runId(11), periodKey: '2026-10-11' }),
			),
		).toEqual({ kind: 'created' });

		// The original run is untouched by the duplicate attempt.
		expect((await repository.findDailyRun(USER_ID, '2026-10-11'))?.id).toBe(runId(7));
		expect((await repository.findDailyRun(USER_ID, '2026-10-11'))?.nextSequence).toBe(0);
	});
});

describe('daily period definition', () => {
	test('concurrent first access converges on one canonical blackjack_daily seed', async () => {
		const [first, second] = await Promise.all([
			repository.getOrCreateDaily('2026-10-11', () => SEED_A, NOW_SECONDS),
			createBlackjackRunRepository(db).getOrCreateDaily('2026-10-11', () => SEED_B, NOW_SECONDS),
		]);

		// Both concurrent first accesses resolve to the single persisted winner
		// seed; whoever loses the unique-key insert race reloads the winning row
		// instead of retaining its locally generated seed.
		const seeds = new Set([first.seed, second.seed]);
		expect(seeds.size).toBe(1);
		const stored = await db
			.prepare('SELECT seed FROM blackjack_daily WHERE periodKey = ?')
			.bind('2026-10-11')
			.first<{ seed: string }>();
		expect(stored?.seed).toBe(first.seed);
		expect(stored?.seed).toBe(second.seed);
	});
});

describe('ranked command appends with stake', () => {
	test('split/double-down additional stake applies atomically with the command', async () => {
		await repository.createRankedRunWithStake(rankedStartInput());
		const nextCommands = JSON.stringify([{ sequence: 0, command: 'split' }]);
		const result = await repository.appendRankedCommandWithStake({
			userId: USER_ID,
			runId: runId(1),
			expectedSequence: 0,
			commandsJson: nextCommands,
			additionalWager: 100,
			nowSeconds: NOW_SECONDS,
		});
		expect(result).toEqual({ kind: 'applied' });

		expect(await readBalance()).toEqual({ chipBalance: 800 });
		const run = await repository.findOwnedRun(USER_ID, runId(1));
		expect(run!.nextSequence).toBe(1);
		expect(run!.commands).toEqual([{ sequence: 0, command: 'split' }]);
	});

	test('insufficient additional stake leaves balance, command log, and sequence unchanged', async () => {
		await repository.createRankedRunWithStake(rankedStartInput());
		const result = await repository.appendRankedCommandWithStake({
			userId: USER_ID,
			runId: runId(1),
			expectedSequence: 0,
			commandsJson: JSON.stringify([{ sequence: 0, command: 'split' }]),
			additionalWager: 1000,
			nowSeconds: NOW_SECONDS,
		});
		expect(result).toEqual({ kind: 'insufficient' });

		expect(await readBalance()).toEqual({ chipBalance: 900 });
		const run = await repository.findOwnedRun(USER_ID, runId(1));
		expect(run!.nextSequence).toBe(0);
		expect(run!.commands).toEqual([]);
	});

	test('additional stake equal to the full remaining balance still applies', async () => {
		await insertTestUser(db, { id: 'edge-user', chipBalance: 200 });
		await repository.createRankedRunWithStake(
			rankedStartInput({ userId: 'edge-user', id: runId(20), initialWager: 100 }),
		);
		const result = await repository.appendRankedCommandWithStake({
			userId: 'edge-user',
			runId: runId(20),
			expectedSequence: 0,
			commandsJson: JSON.stringify([{ sequence: 0, command: 'double-down' }]),
			additionalWager: 100,
			nowSeconds: NOW_SECONDS,
		});
		expect(result).toEqual({ kind: 'applied' });
		expect(await readBalance('edge-user')).toEqual({ chipBalance: 0 });
		const run = await repository.findOwnedRun('edge-user', runId(20));
		expect(run!.nextSequence).toBe(1);
	});

	test('non-wager command advances the run without any balance change', async () => {
		await repository.createRankedRunWithStake(rankedStartInput());
		const before = await readBalance();
		const result = await repository.appendRankedCommandWithStake({
			userId: USER_ID,
			runId: runId(1),
			expectedSequence: 0,
			commandsJson: JSON.stringify([{ sequence: 0, command: 'hit' }]),
			additionalWager: 0,
			nowSeconds: NOW_SECONDS,
		});
		expect(result).toEqual({ kind: 'applied' });
		expect(await readBalance()).toEqual(before);
		const run = await repository.findOwnedRun(USER_ID, runId(1));
		expect(run!.nextSequence).toBe(1);
		expect(run!.commands).toEqual([{ sequence: 0, command: 'hit' }]);
	});

	test('stale-sequence wager command cannot move chips', async () => {
		await repository.createRankedRunWithStake(rankedStartInput());
		const first = await repository.appendRankedCommandWithStake({
			userId: USER_ID,
			runId: runId(1),
			expectedSequence: 0,
			commandsJson: JSON.stringify([{ sequence: 0, command: 'hit' }]),
			additionalWager: 0,
			nowSeconds: NOW_SECONDS,
		});
		expect(first).toEqual({ kind: 'applied' });

		// A stale split that expected sequence 0 must not append or debit.
		const stale = await repository.appendRankedCommandWithStake({
			userId: USER_ID,
			runId: runId(1),
			expectedSequence: 0,
			commandsJson: JSON.stringify([{ sequence: 0, command: 'split' }]),
			additionalWager: 100,
			nowSeconds: NOW_SECONDS,
		});
		expect(stale).toEqual({ kind: 'not-applied' });
		expect(await readBalance()).toEqual({ chipBalance: 900 });
		const run = await repository.findOwnedRun(USER_ID, runId(1));
		expect(run!.nextSequence).toBe(1);
		expect(run!.commands).toEqual([{ sequence: 0, command: 'hit' }]);
	});

	test('an expired wager append is not applied and does not debit the balance', async () => {
		const expiredAt = realNowSeconds() - 1;
		await repository.createRankedRunWithStake(
			rankedStartInput({ id: runId(21), expiresAt: expiredAt }),
		);
		const result = await repository.appendRankedCommandWithStake({
			userId: USER_ID,
			runId: runId(21),
			expectedSequence: 0,
			commandsJson: JSON.stringify([{ sequence: 0, command: 'split' }]),
			additionalWager: 100,
			nowSeconds: NOW_SECONDS,
		});
		expect(result).toEqual({ kind: 'not-applied' });
		expect(await readBalance()).toEqual({ chipBalance: 900 });
		const run = await repository.findOwnedRun(USER_ID, runId(21));
		expect(run!.nextSequence).toBe(0);
		expect(run!.commands).toEqual([]);
	});

	test('a stale nowSeconds captured before TTL cannot commit a command after TTL', async () => {
		// Simulate the interleaving race: the request captured nowSeconds
		// BEFORE the run expired, but the DB write happens AFTER TTL. With the
		// old expiresAt > ? bound to nowSeconds, the CAS would pass (stale
		// timestamp) and the command would commit post-expiry. With
		// expiresAt > unixepoch() the CAS uses DB time at write execution and
		// correctly rejects the late write.
		const expiresAt = realNowSeconds() - 1;
		const staleNowSeconds = realNowSeconds() - 2; // captured before expiresAt
		await repository.createRankedRunWithStake(
			rankedStartInput({ id: runId(22), expiresAt: expiresAt }),
		);
		const result = await repository.appendRankedCommandWithStake({
			userId: USER_ID,
			runId: runId(22),
			expectedSequence: 0,
			commandsJson: JSON.stringify([{ sequence: 0, command: 'split' }]),
			additionalWager: 100,
			nowSeconds: staleNowSeconds,
		});
		expect(result).toEqual({ kind: 'not-applied' });
		expect(await readBalance()).toEqual({ chipBalance: 900 });
		const run = await repository.findOwnedRun(USER_ID, runId(22));
		expect(run!.nextSequence).toBe(0);
		expect(run!.commands).toEqual([]);
	});
});

describe('daily command appends', () => {
	test('daily appends never touch the account balance', async () => {
		await insertTestUser(db, { id: 'daily-user-3', chipBalance: 500 });
		await repository.createDailyRun(
			dailyStartInput({ userId: 'daily-user-3', id: runId(30), periodKey: '2026-10-11' }),
		);
		const before = await readBalance('daily-user-3');

		const commands = [
			{ sequence: 0, command: 'start-round', wager: 100 },
			{ sequence: 1, command: 'hit' },
			{ sequence: 2, command: 'stand' },
		];
		for (let index = 0; index < commands.length; index += 1) {
			const result = await repository.appendDailyCommand({
				userId: 'daily-user-3',
				runId: runId(30),
				expectedSequence: index,
				commandsJson: JSON.stringify(commands.slice(0, index + 1)),
				nowSeconds: NOW_SECONDS + index,
			});
			expect(result).toEqual({ kind: 'applied' });
		}

		expect(await readBalance('daily-user-3')).toEqual(before);
		const run = await repository.findDailyRun('daily-user-3', '2026-10-11');
		expect(run!.nextSequence).toBe(3);
		expect(run!.commands).toEqual(commands);
	});

	test('an expired daily append is not applied and leaves the log and balance unchanged', async () => {
		const expiredAt = realNowSeconds() - 1;
		await repository.createDailyRun(dailyStartInput({ id: runId(31), expiresAt: expiredAt }));
		const before = await readBalance();
		const result = await repository.appendDailyCommand({
			userId: USER_ID,
			runId: runId(31),
			expectedSequence: 0,
			commandsJson: JSON.stringify([{ sequence: 0, command: 'start-round', wager: 100 }]),
			nowSeconds: NOW_SECONDS,
		});
		expect(result).toEqual({ kind: 'not-applied' });
		expect(await readBalance()).toEqual(before);
		const run = await repository.findDailyRun(USER_ID, '2026-10-11');
		expect(run!.nextSequence).toBe(0);
		expect(run!.commands).toEqual([]);
	});

	test('a stale nowSeconds captured before TTL cannot commit a daily command after TTL', async () => {
		// Same interleaving race as the Ranked variant: nowSeconds was
		// captured before the run expired, but the DB write happens after
		// TTL. The DB-time CAS (expiresAt > unixepoch()) must reject it.
		const expiresAt = realNowSeconds() - 1;
		const staleNowSeconds = realNowSeconds() - 2;
		await repository.createDailyRun(dailyStartInput({ id: runId(32), expiresAt: expiresAt }));
		const result = await repository.appendDailyCommand({
			userId: USER_ID,
			runId: runId(32),
			expectedSequence: 0,
			commandsJson: JSON.stringify([{ sequence: 0, command: 'start-round', wager: 100 }]),
			nowSeconds: staleNowSeconds,
		});
		expect(result).toEqual({ kind: 'not-applied' });
		const run = await repository.findDailyRun(USER_ID, '2026-10-11');
		expect(run!.nextSequence).toBe(0);
		expect(run!.commands).toEqual([]);
	});
});

describe('terminal run updates', () => {
	test('terminal update clears activeUserId once and cannot re-apply', async () => {
		await repository.createRankedRunWithStake(rankedStartInput());
		const resultJson = JSON.stringify({ result: 'loss', payout: 0 });

		const terminal = await repository.finishRun({
			userId: USER_ID,
			runId: runId(1),
			mode: 'ranked',
			expectedSequence: 0,
			status: 'settled',
			resultJson,
			dailyEndingBankroll: null,
			dailyRoundsCompleted: null,
			nowSeconds: NOW_SECONDS,
		});
		expect(terminal).toEqual({ kind: 'applied' });

		expect(await repository.findActiveRun(USER_ID, 'ranked')).toBeNull();
		const run = await repository.findOwnedRun(USER_ID, runId(1));
		expect(run!.status).toBe('settled');
		expect(run!.activeUserId).toBeNull();
		expect(run!.resultJson).toBe(resultJson);
		expect(run!.settledAt).toBe(NOW_SECONDS);

		const again = await repository.finishRun({
			userId: USER_ID,
			runId: runId(1),
			mode: 'ranked',
			expectedSequence: 0,
			status: 'settled',
			resultJson,
			dailyEndingBankroll: null,
			dailyRoundsCompleted: null,
			nowSeconds: NOW_SECONDS,
		});
		expect(again).toEqual({ kind: 'not-applied' });
	});

	test('daily completed projections persist and forfeited projections stay null', async () => {
		await repository.createDailyRun(dailyStartInput({ id: runId(40) }));
		const completed = await repository.finishRun({
			userId: USER_ID,
			runId: runId(40),
			mode: 'daily',
			expectedSequence: 0,
			status: 'completed',
			resultJson: null,
			dailyEndingBankroll: 1200,
			dailyRoundsCompleted: 10,
			nowSeconds: NOW_SECONDS,
		});
		expect(completed).toEqual({ kind: 'applied' });
		const done = await repository.findDailyRun(USER_ID, '2026-10-11');
		expect(done!.status).toBe('completed');
		expect(done!.dailyEndingBankroll).toBe(1200);
		expect(done!.dailyRoundsCompleted).toBe(10);
		expect(done!.settledAt).toBe(NOW_SECONDS);

		await repository.createDailyRun(dailyStartInput({ id: runId(41), periodKey: '2026-10-12' }));
		const forfeited = await repository.finishRun({
			userId: USER_ID,
			runId: runId(41),
			mode: 'daily',
			expectedSequence: 0,
			status: 'forfeited',
			resultJson: null,
			dailyEndingBankroll: null,
			dailyRoundsCompleted: null,
			nowSeconds: NOW_SECONDS,
		});
		expect(forfeited).toEqual({ kind: 'applied' });
		const gone = await repository.findDailyRun(USER_ID, '2026-10-12');
		expect(gone!.status).toBe('forfeited');
		expect(gone!.dailyEndingBankroll).toBeNull();
		expect(gone!.dailyRoundsCompleted).toBeNull();
	});
});

describe('daily leaderboard', () => {
	const players = [
		{ id: 'leader-a', bankroll: 2000, rounds: 10, settledAt: NOW_SECONDS + 100 },
		{ id: 'leader-b', bankroll: 2000, rounds: 8, settledAt: NOW_SECONDS + 200 },
		{ id: 'leader-c', bankroll: 1500, rounds: 10, settledAt: NOW_SECONDS + 300 },
		// Tied with leader-a on score; earlier settledAt breaks the display order.
		{ id: 'leader-d', bankroll: 2000, rounds: 10, settledAt: NOW_SECONDS + 50 },
	];

	test('orders completed runs and reports current-user standing', async () => {
		for (const player of players) {
			await insertTestUser(db, { id: player.id, chipBalance: 100 });
			await repository.createDailyRun(
				dailyStartInput({
					userId: player.id,
					id: `leader-run-${player.id}`,
					periodKey: '2026-10-11',
				}),
			);
			await repository.finishRun({
				userId: player.id,
				runId: `leader-run-${player.id}`,
				mode: 'daily',
				expectedSequence: 0,
				status: 'completed',
				resultJson: null,
				dailyEndingBankroll: player.bankroll,
				dailyRoundsCompleted: player.rounds,
				nowSeconds: player.settledAt,
			});
		}
		// Non-eligible rows (forfeited, active) must be excluded.
		await insertTestUser(db, { id: 'leader-e', chipBalance: 100 });
		await repository.createDailyRun(
			dailyStartInput({ userId: 'leader-e', id: 'leader-run-leader-e', periodKey: '2026-10-11' }),
		);
		await repository.finishRun({
			userId: 'leader-e',
			runId: 'leader-run-leader-e',
			mode: 'daily',
			expectedSequence: 0,
			status: 'forfeited',
			resultJson: null,
			dailyEndingBankroll: null,
			dailyRoundsCompleted: null,
			nowSeconds: NOW_SECONDS + 400,
		});
		await insertTestUser(db, { id: 'leader-f', chipBalance: 100 });
		await repository.createDailyRun(
			dailyStartInput({ userId: 'leader-f', id: 'leader-run-leader-f', periodKey: '2026-10-11' }),
		);

		const read = await repository.listDailyLeaderboard('2026-10-11', 50, 'leader-a');
		expect(read.entries.map((entry) => entry.userId)).toEqual([
			'leader-d',
			'leader-a',
			'leader-b',
			'leader-c',
		]);
		expect(read.entries.map((entry) => entry.rank)).toEqual([1, 1, 3, 4]);
		expect(read.entries[0]).toEqual({
			rank: 1,
			userId: 'leader-d',
			playerName: 'Test leader-d',
			dailyEndingBankroll: 2000,
			dailyRoundsCompleted: 10,
			settledAt: NOW_SECONDS + 50,
		});
		// Tied scores share the same rank (RANK), so leader-a is rank 1 of 4.
		expect(read.currentUser).toEqual({ rank: 1, totalEligible: 4, percentile: 100 });

		const standingC = await repository.listDailyLeaderboard('2026-10-11', 50, 'leader-c');
		expect(standingC.currentUser).toEqual({ rank: 4, totalEligible: 4, percentile: 25 });

		// Forfeited participants and non-participants have no standing.
		const standingE = await repository.listDailyLeaderboard('2026-10-11', 50, 'leader-e');
		expect(standingE.currentUser).toBeNull();
		const standingNobody = await repository.listDailyLeaderboard('2026-10-11', 50, 'no-such-user');
		expect(standingNobody.currentUser).toBeNull();

		// A different period is a different leaderboard.
		const other = await repository.listDailyLeaderboard('2026-10-12', 50, 'leader-a');
		expect(other.entries).toEqual([]);
		expect(other.currentUser).toBeNull();
	});
});

describe('weekly leaderboard', () => {
	test('aggregates current-week completed Daily runs and returns an out-of-top current user', async () => {
		const aliceId = 'weekly-alice';
		const bobId = 'weekly-bob';
		const carolId = 'weekly-carol';
		const daveId = 'weekly-dave';
		const rankedId = 'weekly-ranked';
		const incompleteId = 'weekly-incomplete';
		await insertTestUser(db, { id: aliceId, name: 'Alice' });
		await insertTestUser(db, { id: bobId, name: 'Bob' });
		await insertTestUser(db, { id: carolId, name: 'Carol' });
		await insertTestUser(db, { id: daveId, name: 'Dave' });
		await insertTestUser(db, { id: rankedId, name: 'Ranked' });
		await insertTestUser(db, { id: incompleteId, name: 'Incomplete' });

		await completeDailyRun({
			userId: aliceId,
			runSequence: 100,
			periodKey: '2026-08-17',
			endingBankroll: 1200,
			roundsCompleted: 10,
			settledAt: 100,
		});
		await completeDailyRun({
			userId: aliceId,
			runSequence: 101,
			periodKey: '2026-08-18',
			endingBankroll: 900,
			roundsCompleted: 8,
			settledAt: 200,
		});
		await completeDailyRun({
			userId: bobId,
			runSequence: 102,
			periodKey: '2026-08-17',
			endingBankroll: 2200,
			roundsCompleted: 10,
			settledAt: 150,
		});
		await completeDailyRun({
			userId: carolId,
			runSequence: 103,
			periodKey: '2026-08-17',
			endingBankroll: 1100,
			roundsCompleted: 7,
			settledAt: 120,
		});
		await completeDailyRun({
			userId: carolId,
			runSequence: 104,
			periodKey: '2026-08-18',
			endingBankroll: 1000,
			roundsCompleted: 7,
			settledAt: 180,
		});
		await completeDailyRun({
			userId: daveId,
			runSequence: 105,
			periodKey: '2026-08-16',
			endingBankroll: 9999,
			roundsCompleted: 10,
			settledAt: 90,
		});

		expect(
			await repository.createRankedRunWithStake({
				...rankedStartInput({ userId: rankedId, id: runId(106) }),
			}),
		).toEqual({ kind: 'applied' });
		expect(
			await repository.createDailyRun(
				dailyStartInput({
					userId: incompleteId,
					id: runId(107),
					periodKey: '2026-08-19',
				}),
			),
		).toEqual({ kind: 'created' });

		const read = await repository.listWeeklyLeaderboard('2026-08-17', '2026-08-24', 2, carolId);

		expect(
			read.entries.map((entry) => ({
				name: entry.playerName,
				score: entry.weeklyScore,
				days: entry.daysPlayed,
			})),
		).toEqual([
			{ name: 'Bob', score: 2200, days: 1 },
			{ name: 'Alice', score: 2100, days: 2 },
		]);

		expect(read.currentUser).toEqual({
			rank: 3,
			totalEligible: 3,
			weeklyScore: 2100,
			daysPlayed: 2,
		});
		expect(read.entries.every((entry) => entry.totalEligible === 3)).toBe(true);
	});

	test('orders equal weekly scores by days, rounds, settled time, and user id', async () => {
		const fixtures = [
			{
				id: 'tie-days-more',
				name: 'Days More',
				score: 1000,
				rounds: 3,
				settledAt: 100,
				periodKey: '2026-08-17',
				runSequence: 200,
			},
			{
				id: 'tie-days-more',
				name: 'Days More',
				score: 1000,
				rounds: 3,
				settledAt: 200,
				periodKey: '2026-08-18',
				runSequence: 201,
			},
			{
				id: 'tie-days-fewer',
				name: 'Days Fewer',
				score: 2000,
				rounds: 10,
				settledAt: 50,
				periodKey: '2026-08-17',
				runSequence: 202,
			},
			{
				id: 'tie-rounds-more',
				name: 'Rounds More',
				score: 1900,
				rounds: 10,
				settledAt: 300,
				periodKey: '2026-08-17',
				runSequence: 203,
			},
			{
				id: 'tie-rounds-fewer',
				name: 'Rounds Fewer',
				score: 1900,
				rounds: 8,
				settledAt: 100,
				periodKey: '2026-08-17',
				runSequence: 204,
			},
			{
				id: 'tie-settled-earlier',
				name: 'Settled Earlier',
				score: 1800,
				rounds: 8,
				settledAt: 400,
				periodKey: '2026-08-17',
				runSequence: 205,
			},
			{
				id: 'tie-settled-later',
				name: 'Settled Later',
				score: 1800,
				rounds: 8,
				settledAt: 500,
				periodKey: '2026-08-17',
				runSequence: 206,
			},
			{
				id: 'tie-user-a',
				name: 'User A',
				score: 1700,
				rounds: 8,
				settledAt: 600,
				periodKey: '2026-08-17',
				runSequence: 207,
			},
			{
				id: 'tie-user-b',
				name: 'User B',
				score: 1700,
				rounds: 8,
				settledAt: 600,
				periodKey: '2026-08-17',
				runSequence: 208,
			},
		] as const;

		const insertedUserIds = new Set<string>();
		for (const fixture of fixtures) {
			if (!insertedUserIds.has(fixture.id)) {
				await insertTestUser(db, { id: fixture.id, name: fixture.name });
				insertedUserIds.add(fixture.id);
			}
			await completeDailyRun({
				userId: fixture.id,
				runSequence: fixture.runSequence,
				periodKey: fixture.periodKey,
				endingBankroll: fixture.score,
				roundsCompleted: fixture.rounds,
				settledAt: fixture.settledAt,
			});
		}

		const first = await repository.listWeeklyLeaderboard('2026-08-17', '2026-08-24', 50);
		const second = await repository.listWeeklyLeaderboard('2026-08-17', '2026-08-24', 50);
		const expected = [
			{ userId: 'tie-days-more', rank: 1 },
			{ userId: 'tie-days-fewer', rank: 2 },
			{ userId: 'tie-rounds-more', rank: 3 },
			{ userId: 'tie-rounds-fewer', rank: 4 },
			{ userId: 'tie-settled-earlier', rank: 5 },
			{ userId: 'tie-settled-later', rank: 6 },
			{ userId: 'tie-user-a', rank: 7 },
			{ userId: 'tie-user-b', rank: 8 },
		];
		expect(first.entries.map(({ userId, rank }) => ({ userId, rank }))).toEqual(expected);
		expect(second.entries.map(({ userId, rank }) => ({ userId, rank }))).toEqual(expected);
		expect(new Set(first.entries.map((entry) => entry.rank)).size).toBe(expected.length);
	});
});

describe('expired run paging', () => {
	test('pages active expired runs in (expiresAt, id) cursor order', async () => {
		const users = ['exp-user-1', 'exp-user-2', 'exp-user-3', 'exp-user-4', 'exp-user-5'];
		for (const userId of users) {
			await insertTestUser(db, { id: userId, chipBalance: 1000 });
		}
		await insertBlackjackRunRow(db, { id: runId(51), userId: 'exp-user-1', expiresAt: 100 });
		await insertBlackjackRunRow(db, { id: runId(52), userId: 'exp-user-2', expiresAt: 100 });
		await insertBlackjackRunRow(db, { id: runId(53), userId: 'exp-user-3', expiresAt: 50 });
		// Not expired yet at the query cutoff: never listed.
		await insertBlackjackRunRow(db, { id: runId(54), userId: 'exp-user-4', expiresAt: 200 });
		// Not active, so never listed.
		await insertBlackjackRunRow(db, {
			id: runId(55),
			userId: 'exp-user-5',
			expiresAt: 100,
			status: 'settled',
		});

		const pageOne = await repository.listExpiredPage(150, null, 2);
		expect(pageOne).toEqual([
			{ id: runId(53), expiresAt: 50 },
			{ id: runId(51), expiresAt: 100 },
		]);

		const cursor = pageOne[pageOne.length - 1];
		const pageTwo = await repository.listExpiredPage(150, cursor, 2);
		expect(pageTwo).toEqual([{ id: runId(52), expiresAt: 100 }]);

		const pageThree = await repository.listExpiredPage(150, pageTwo[pageTwo.length - 1], 2);
		expect(pageThree).toEqual([]);
	});

	test('bounds the page size to the exported limit', async () => {
		await insertTestUser(db, { id: 'exp-user-6', chipBalance: 1000 });
		for (let index = 0; index < 3; index += 1) {
			await insertBlackjackRunRow(db, {
				id: runId(60 + index),
				userId: 'exp-user-6',
				expiresAt: 10 + index,
			});
		}
		const small = await repository.listExpiredPage(100, null, 1);
		expect(small).toHaveLength(1);
		const large = await repository.listExpiredPage(100, null, 10_000);
		expect(large).toHaveLength(3);
		expect(large.length).toBeLessThanOrEqual(BLACKJACK_RUN_EXPIRATION_PAGE_SIZE);
	});
});
