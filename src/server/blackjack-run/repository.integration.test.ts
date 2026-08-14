import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import { createRankedTestD1, insertRankedTestUser } from '../ranked/test-d1';
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

let mf: Miniflare;
let db: D1Database;
let repository: BlackjackRunRepository;

beforeAll(async () => {
	({ mf, db } = await createRankedTestD1());
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
	await insertRankedTestUser(db, { id: USER_ID, chipBalance: 1000 });
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

async function readBalance(userId: string = USER_ID): Promise<{ chipBalance: number }> {
	const row = await db
		.prepare('SELECT chipBalance FROM user WHERE id = ?')
		.bind(userId)
		.first<{ chipBalance: number }>();
	if (!row) throw new Error('missing test user');
	return row;
}

// Direct row inserter for repository test setup (expiration paging, raw-state
// fixtures). Modeled on insertRankedTestUser/insertRankedSession in
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
		await insertRankedTestUser(db, { id: 'low-balance-user', chipBalance: 50 });
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

		await insertRankedTestUser(db, { id: 'daily-user-2', chipBalance: 500 });
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
		await insertRankedTestUser(db, { id: 'edge-user', chipBalance: 200 });
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
});

describe('daily command appends', () => {
	test('daily appends never touch the account balance', async () => {
		await insertRankedTestUser(db, { id: 'daily-user-3', chipBalance: 500 });
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
			await insertRankedTestUser(db, { id: player.id, chipBalance: 100 });
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
		await insertRankedTestUser(db, { id: 'leader-e', chipBalance: 100 });
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
		await insertRankedTestUser(db, { id: 'leader-f', chipBalance: 100 });
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

describe('expired run paging', () => {
	test('pages active expired runs in (expiresAt, id) cursor order', async () => {
		const users = ['exp-user-1', 'exp-user-2', 'exp-user-3', 'exp-user-4', 'exp-user-5'];
		for (const userId of users) {
			await insertRankedTestUser(db, { id: userId, chipBalance: 1000 });
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
		await insertRankedTestUser(db, { id: 'exp-user-6', chipBalance: 1000 });
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
