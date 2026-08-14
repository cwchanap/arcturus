import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import { createBlackjackRunTestD1, insertTestUser } from './test-d1';
import { replayBlackjackRound, type BlackjackRoundOutcome } from '../../lib/blackjack-run/engine';
import { getDailyWindowForPeriodKey, replayDailyRun } from '../../lib/blackjack-run/daily';
import { buildExpiryOutcome } from '../../lib/blackjack-run/ranked';
import {
	BlackjackRunError,
	type BlackjackRunCommand,
	type BlackjackRunPublicState,
} from '../../lib/blackjack-run/protocol';
import { WalletSettlementDomainError } from '../../lib/wallet/settle';
import { readWalletBalance } from '../../lib/wallet/repository';
import type { SettleRoundCommand, SettleRoundResult } from '../../lib/wallet/types';
import { createBlackjackRunRepository, type BlackjackRunRepository } from './repository';
import {
	BlackjackRunServiceError,
	createBlackjackRunService,
	type BlackjackRunService,
} from './service';

const USER_ID = 'blackjack-run-service-user';
const SECOND_USER = 'blackjack-run-service-user-2';
// 2027-01-15T08:00:00Z; NOW + 1801 stays inside the same UTC day.
const NOW_SECONDS = 1_800_000_000;
const PERIOD_KEY = '2027-01-15';
const RANKED_TTL_SECONDS = 15 * 60;
const DAILY_TTL_SECONDS = 1800;

let mf: Miniflare;
let db: D1Database;

beforeAll(async () => {
	({ mf, db } = await createBlackjackRunTestD1());
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

// --- deterministic fixtures ---

/** 32-byte seed with `value` in its first four bytes. */
function seedOf(value: number): Uint8Array {
	const bytes = new Uint8Array(32);
	bytes[0] = value & 0xff;
	bytes[1] = (value >> 8) & 0xff;
	bytes[2] = (value >> 16) & 0xff;
	bytes[3] = (value >> 24) & 0xff;
	return bytes;
}

// Verified seeds (see engine replay):
//  - seedOf(1):  hit/stand available; ['hit','stand'] -> push (payout 100, net 0).
//  - seedOf(4):  opening player blackjack -> terminal (payout 250, net +150).
//  - seedOf(13): opening pair -> split legal; ['split','stand','stand'] -> win (payout 400, net +200).
//  - seedOf(18): opening 9..11 -> double-down legal; ['double-down'] -> win (payout 400, net +200).
// Daily master seeds (round decks derive per-round from the master):
//  - seedOf(0):  wager-10 stand strategy completes 10 rounds at 980; wager-1000 stand
//                strategy loses round 0 -> bankroll-below-minimum at 0.
//  - seedOf(10): round 0 double-down legal; ['start-round(100)','double-down'] -> loss (bankroll 800).

// Run-id bytes and any exhausted-chunk fallback are minted per harness so
// two harnesses in one test never collide on the run-id primary key. The
// caller's seed is always served as the second chunk (ranked/daily start).
let randomBytesInstance = 0;
function randomBytesOf(seed: Uint8Array): (length: number) => Uint8Array {
	randomBytesInstance += 1;
	const idBytes = new Uint8Array(16).fill(randomBytesInstance);
	let index = 0;
	return (length: number) => {
		const chunk =
			index === 0
				? idBytes
				: index === 1
					? seed
					: new Uint8Array(length).fill(0x40 + randomBytesInstance);
		index += 1;
		if (chunk.length !== length) throw new Error('randomBytes fixture length mismatch');
		return chunk;
	};
}

interface SettleCall {
	userId: string;
	command: SettleRoundCommand;
}

interface SettleSpy {
	spy: (_db: D1Database, userId: string, command: SettleRoundCommand) => Promise<SettleRoundResult>;
	calls: SettleCall[];
	setConflict(value: boolean): void;
	/** When set, the spy finishes the run itself before returning (simulates a racing finalizer). */
	setFinishInsideSettle(resultJson: string | null): void;
}

function createSettleSpy(repository: BlackjackRunRepository): SettleSpy {
	const calls: SettleCall[] = [];
	let conflict = false;
	let finishInsideSettle: string | null = null;
	return {
		calls,
		setConflict(value) {
			conflict = value;
		},
		setFinishInsideSettle(resultJson) {
			finishInsideSettle = resultJson;
		},
		async spy(_db, userId, command) {
			calls.push({ userId, command });
			if (conflict) throw new WalletSettlementDomainError('SETTLEMENT_CONFLICT');
			if (finishInsideSettle !== null) {
				const runId = command.settlementId.replace('blackjack-run-', '');
				const run = await repository.findOwnedRun(userId, runId);
				if (run) {
					await repository.finishRun({
						userId,
						runId,
						mode: 'ranked',
						expectedSequence: run.nextSequence,
						status: 'settled',
						resultJson: finishInsideSettle,
						dailyEndingBankroll: null,
						dailyRoundsCompleted: null,
						nowSeconds: NOW_SECONDS,
					});
				}
			}
			// Mirror the real settlement: persist the credit (delta >= 0) and
			// return the new balance.
			const current = (await readWalletBalance(db, userId)) ?? 0;
			const balance = current + command.delta;
			await db
				.prepare('UPDATE user SET chipBalance = ?, updatedAt = ? WHERE id = ?')
				.bind(balance, NOW_SECONDS, userId)
				.run();
			return { balance, duplicate: false };
		},
	};
}

interface Harness {
	service: BlackjackRunService;
	repository: BlackjackRunRepository;
	spy: SettleSpy;
	setNow(seconds: number): void;
}

function makeService(randomBytes: (length: number) => Uint8Array): Harness {
	const repository = createBlackjackRunRepository(db);
	let currentNow = NOW_SECONDS;
	const spy = createSettleSpy(repository);
	const service = createBlackjackRunService({
		repository,
		db,
		now: () => currentNow,
		randomBytes,
		settleWallet: spy.spy,
		readBalance: readWalletBalance,
	});
	return {
		service,
		repository,
		spy,
		setNow(seconds) {
			currentNow = seconds;
		},
	};
}

async function readChipBalance(userId: string = USER_ID): Promise<number> {
	return (await readWalletBalance(db, userId)) ?? -1;
}

async function expectServiceError(
	promise: Promise<unknown>,
	code: BlackjackRunServiceError['code'],
): Promise<BlackjackRunServiceError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(BlackjackRunServiceError);
		expect((error as BlackjackRunServiceError).code).toBe(code);
		return error as BlackjackRunServiceError;
	}
	throw new Error(`expected BlackjackRunServiceError ${code}`);
}

async function expectCoreError(
	promise: Promise<unknown>,
	code: BlackjackRunError['code'],
	expectedSequence?: number,
): Promise<BlackjackRunError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(BlackjackRunError);
		expect((error as BlackjackRunError).code).toBe(code);
		if (expectedSequence !== undefined) {
			expect((error as BlackjackRunError).expectedSequence).toBe(expectedSequence);
		}
		return error as BlackjackRunError;
	}
	throw new Error(`expected BlackjackRunError ${code}`);
}

function rankedStart(requestId: string, wager: number) {
	return { mode: 'ranked' as const, requestId, wager };
}

function action(sequence: number, command: 'hit' | 'stand' | 'double-down' | 'split') {
	return { sequence, command };
}

function dailyStart(requestId: string, periodKey: string = PERIOD_KEY) {
	return { mode: 'daily' as const, requestId, periodKey };
}

function isRankedState(state: BlackjackRunPublicState) {
	if (state.mode !== 'ranked') throw new Error('expected ranked state');
	return state;
}

function isDailyState(state: BlackjackRunPublicState) {
	if (state.mode !== 'daily') throw new Error('expected daily state');
	return state;
}

/** Builds the full command log for the "wager + stand until terminal" Daily strategy. */
function buildDailyStandLog(seed: Uint8Array, wager: number): BlackjackRunCommand[] {
	const log: BlackjackRunCommand[] = [];
	for (let guard = 0; guard < 300; guard += 1) {
		const replay = replayDailyRun(seed, log);
		if (replay.status !== 'active') return log;
		if (replay.activeRound === null) {
			log.push({ sequence: log.length, command: 'start-round', wager });
			continue;
		}
		if (replay.activeRound.replay.state.phase === 'player-turn') {
			log.push({ sequence: log.length, command: 'stand' });
			continue;
		}
		throw new Error('daily strategy stuck');
	}
	throw new Error('daily strategy guard');
}

// --- Step 4.1: Ranked lifecycle tests ---

describe('ranked lifecycle', () => {
	test('1: valid start returns the post-debit state; invalid wagers are rejected', async () => {
		const { service, spy } = makeService(randomBytesOf(seedOf(1)));
		const state = isRankedState(
			await service.start(USER_ID, rankedStart('request-ranked-0001', 100)),
		);
		expect(state.status).toBe('active');
		expect(state.balance).toBe(900);
		expect(state.expiresAt).toBe(NOW_SECONDS + RANKED_TTL_SECONDS);
		expect(state.nextSequence).toBe(0);
		expect(state.availableActions).toContain('hit');
		expect(state.availableActions).toContain('stand');
		expect(await readChipBalance()).toBe(900);
		expect(spy.calls).toHaveLength(0);

		await expectCoreError(
			service.start(USER_ID, rankedStart('request-ranked-0002', 5)),
			'INVALID_WAGER',
		);
		await expectCoreError(
			service.start(USER_ID, rankedStart('request-ranked-0003', 1001)),
			'INVALID_WAGER',
		);
		expect(await readChipBalance()).toBe(900);
		expect(spy.calls).toHaveLength(0);
	});

	test('2: the same request ID returns the same run without a second debit', async () => {
		const { service, spy, repository } = makeService(randomBytesOf(seedOf(1)));
		const first = isRankedState(
			await service.start(USER_ID, rankedStart('request-ranked-0001', 100)),
		);
		const replay = isRankedState(
			await service.start(USER_ID, rankedStart('request-ranked-0001', 100)),
		);
		expect(replay.runId).toBe(first.runId);
		expect(replay.status).toBe('active');
		expect(await readChipBalance()).toBe(900);
		expect(spy.calls).toHaveLength(0);

		const rows = await db
			.prepare('SELECT COUNT(*) AS count FROM blackjack_run WHERE userId = ?')
			.bind(USER_ID)
			.first<{ count: number }>();
		expect(rows?.count).toBe(1);
	});

	test('3: mismatched request-ID reuse is invalid', async () => {
		const { service } = makeService(randomBytesOf(seedOf(1)));
		await service.start(USER_ID, rankedStart('request-ranked-0001', 100));
		await expectServiceError(
			service.start(USER_ID, rankedStart('request-ranked-0001', 200)),
			'IDENTIFIER_REUSE_MISMATCH',
		);
		expect(await readChipBalance()).toBe(900);
	});

	test('4: a second active Ranked run is rejected', async () => {
		const { service, repository } = makeService(randomBytesOf(seedOf(1)));
		const first = isRankedState(
			await service.start(USER_ID, rankedStart('request-ranked-0001', 100)),
		);
		await expectServiceError(
			service.start(USER_ID, rankedStart('request-ranked-0002', 100)),
			'ACTIVE_RUN_EXISTS',
		);
		const active = await repository.findActiveRun(USER_ID, 'ranked');
		expect(active?.id).toBe(first.runId);
		expect(await readChipBalance()).toBe(900);
	});

	test('5: start subtracts the initial stake exactly once', async () => {
		const { service, spy, repository } = makeService(randomBytesOf(seedOf(1)));
		await service.start(USER_ID, rankedStart('request-ranked-0001', 100));
		expect(await readChipBalance()).toBe(900);
		// A second start with a fresh request ID must not move chips again.
		await expectServiceError(
			service.start(USER_ID, rankedStart('request-ranked-0002', 100)),
			'ACTIVE_RUN_EXISTS',
		);
		expect(await readChipBalance()).toBe(900);
		const run = await repository.findActiveRun(USER_ID, 'ranked');
		expect(run?.initialWager).toBe(100);
		expect(run?.nextSequence).toBe(0);
		expect(spy.calls).toHaveLength(0);
	});

	test('6: an opening natural terminal settles the payout exactly once', async () => {
		const { service, spy, repository } = makeService(randomBytesOf(seedOf(4)));
		const state = isRankedState(
			await service.start(USER_ID, rankedStart('request-ranked-0001', 100)),
		);
		expect(state.status).toBe('settled');
		expect(state.phase).toBe('complete');
		expect(state.outcome?.result).toBe('win');
		expect(state.outcome?.payout).toBe(250);
		expect(state.balance).toBe(1150);
		expect(spy.calls).toHaveLength(1);

		const run = await repository.findOwnedRun(USER_ID, state.runId);
		expect(run?.status).toBe('settled');
		expect(run?.activeUserId).toBeNull();

		// A later read converges on the stored terminal row without re-settling.
		const again = isRankedState(await service.get(USER_ID, state.runId));
		expect(again.status).toBe('settled');
		expect(again.balance).toBe(1150);
		expect(spy.calls).toHaveLength(1);
	});

	test('7: hit/stand advance the command sequence and current tracks the run', async () => {
		const { service, spy, repository } = makeService(randomBytesOf(seedOf(1)));
		const started = isRankedState(
			await service.start(USER_ID, rankedStart('request-ranked-0001', 100)),
		);
		expect(started.availableActions).toEqual(['hit', 'stand']);

		const afterHit = isRankedState(await service.command(USER_ID, started.runId, action(0, 'hit')));
		expect(afterHit.nextSequence).toBe(1);
		expect(afterHit.playerHands[0].cards).toHaveLength(3);
		expect(afterHit.balance).toBe(900);
		expect(await readChipBalance()).toBe(900);

		const current = isRankedState(await service.current(USER_ID, 'ranked'));
		expect(current.runId).toBe(started.runId);
		expect(current.nextSequence).toBe(1);

		const settled = isRankedState(
			await service.command(USER_ID, started.runId, action(1, 'stand')),
		);
		expect(settled.status).toBe('settled');
		expect(settled.outcome?.result).toBe('push');
		expect(settled.outcome?.payout).toBe(100);
		expect(settled.balance).toBe(1000);
		expect(await readChipBalance()).toBe(1000);

		const run = await repository.findOwnedRun(USER_ID, started.runId);
		expect(run?.nextSequence).toBe(2);
		expect(run?.commands).toEqual([action(0, 'hit'), action(1, 'stand')]);
		expect(spy.calls).toHaveLength(1);

		// A stale matching command on a terminal run replays the stored state.
		const replay = isRankedState(await service.command(USER_ID, started.runId, action(0, 'hit')));
		expect(replay.status).toBe('settled');
		expect(spy.calls).toHaveLength(1);
	});

	test('8: split and double-down subtract the additional stake exactly once', async () => {
		const { service, spy } = makeService(randomBytesOf(seedOf(13)));
		const splitRun = isRankedState(
			await service.start(USER_ID, rankedStart('request-ranked-0001', 100)),
		);
		expect(splitRun.availableActions).toContain('split');

		const afterSplit = isRankedState(
			await service.command(USER_ID, splitRun.runId, action(0, 'split')),
		);
		expect(afterSplit.playerHands).toHaveLength(2);
		expect(afterSplit.nextSequence).toBe(1);
		expect(afterSplit.committedWager).toBe(200);
		expect(await readChipBalance()).toBe(800);

		await service.command(USER_ID, splitRun.runId, action(1, 'stand'));
		const splitSettled = isRankedState(
			await service.command(USER_ID, splitRun.runId, action(2, 'stand')),
		);
		expect(splitSettled.status).toBe('settled');
		expect(splitSettled.outcome?.payout).toBe(400);
		expect(splitSettled.balance).toBe(1200);
		expect(await readChipBalance()).toBe(1200);
		expect(spy.calls).toHaveLength(1);

		// Double-down on a second user with a double-down-legal seed.
		await insertTestUser(db, { id: SECOND_USER, chipBalance: 1000 });
		const doubleService = makeService(randomBytesOf(seedOf(18)));
		const doubleRun = isRankedState(
			await doubleService.service.start(SECOND_USER, rankedStart('request-ranked-0001', 100)),
		);
		expect(doubleRun.availableActions).toContain('double-down');
		const afterDouble = isRankedState(
			await doubleService.service.command(SECOND_USER, doubleRun.runId, action(0, 'double-down')),
		);
		expect(afterDouble.status).toBe('settled');
		expect(afterDouble.committedWager).toBe(200);
		expect(afterDouble.outcome?.payout).toBe(400);
		expect(await readChipBalance(SECOND_USER)).toBe(1200);
		expect(doubleService.spy.calls).toHaveLength(1);
	});

	test('9: insufficient additional stake does not append the command', async () => {
		await db.prepare('UPDATE user SET chipBalance = 100 WHERE id = ?').bind(USER_ID).run();
		const { service, spy, repository } = makeService(randomBytesOf(seedOf(13)));
		const state = isRankedState(
			await service.start(USER_ID, rankedStart('request-ranked-0001', 100)),
		);
		expect(state.balance).toBe(0);
		// The unfunded split is filtered from the projected actions.
		expect(state.availableActions).not.toContain('split');

		await expectServiceError(
			service.command(USER_ID, state.runId, action(0, 'split')),
			'INSUFFICIENT_BALANCE',
		);
		const run = await repository.findOwnedRun(USER_ID, state.runId);
		expect(run?.nextSequence).toBe(0);
		expect(run?.commands).toEqual([]);
		expect(await readChipBalance()).toBe(0);
		expect(spy.calls).toHaveLength(0);
	});

	test('10: sequence mismatches surface the expected sequence', async () => {
		const { service } = makeService(randomBytesOf(seedOf(1)));
		const state = isRankedState(
			await service.start(USER_ID, rankedStart('request-ranked-0001', 100)),
		);

		await expectCoreError(
			service.command(USER_ID, state.runId, action(3, 'hit')),
			'SEQUENCE_MISMATCH',
			0,
		);
		await expectCoreError(
			service.command(USER_ID, state.runId, action(0, 'double-down')),
			'INVALID_ACTION',
		);

		await service.command(USER_ID, state.runId, action(0, 'hit'));
		// Stale command matching the log replays the current state.
		const replay = isRankedState(await service.command(USER_ID, state.runId, action(0, 'hit')));
		expect(replay.nextSequence).toBe(1);
		// A stale command that does not match the log is reuse mismatch.
		await expectServiceError(
			service.command(USER_ID, state.runId, action(0, 'stand')),
			'IDENTIFIER_REUSE_MISMATCH',
		);
		await expectCoreError(
			service.command(USER_ID, state.runId, action(5, 'stand')),
			'SEQUENCE_MISMATCH',
			1,
		);
	});

	test('11: terminal settlement uses a stable ID, delta=payout, netProfit=gameNetDelta', async () => {
		const { service, spy } = makeService(randomBytesOf(seedOf(1)));
		const state = isRankedState(
			await service.start(USER_ID, rankedStart('request-ranked-0001', 100)),
		);
		await service.command(USER_ID, state.runId, action(0, 'hit'));
		await service.command(USER_ID, state.runId, action(1, 'stand'));

		expect(spy.calls).toHaveLength(1);
		expect(spy.calls[0].userId).toBe(USER_ID);
		expect(spy.calls[0].command).toEqual({
			settlementId: `blackjack-run-${state.runId}`,
			game: 'blackjack',
			delta: 100,
			stats: { rounds: 1, wins: 0, losses: 0, biggestWin: 0, netProfit: 0 },
		});

		// Opening-blackjack terminal: delta = payout, netProfit = +150.
		await insertTestUser(db, { id: SECOND_USER, chipBalance: 1000 });
		const blackjackService = makeService(randomBytesOf(seedOf(4)));
		const blackjack = isRankedState(
			await blackjackService.service.start(SECOND_USER, rankedStart('request-ranked-0001', 100)),
		);
		expect(blackjack.status).toBe('settled');
		expect(blackjackService.spy.calls[0].command).toEqual({
			settlementId: `blackjack-run-${blackjack.runId}`,
			game: 'blackjack',
			delta: 250,
			stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 150, netProfit: 150 },
		});
	});

	test('12: wallet commit with a failed finishRun converges on a later call', async () => {
		const expectedOutcome = replayBlackjackRound({
			seed: seedOf(4),
			initialWager: 100,
			actions: [],
		}).outcome as BlackjackRoundOutcome;
		const { service, spy, repository } = makeService(randomBytesOf(seedOf(4)));
		// Simulate a racing finalizer: the wallet commits, then the racing
		// writer finishes the run before our finishRun CAS runs.
		spy.setFinishInsideSettle(JSON.stringify(expectedOutcome));

		const state = isRankedState(
			await service.start(USER_ID, rankedStart('request-ranked-0001', 100)),
		);
		expect(state.status).toBe('settled');
		expect(state.outcome).toEqual(expectedOutcome);
		expect(state.balance).toBe(1150);
		expect(spy.calls).toHaveLength(1);

		const run = await repository.findOwnedRun(USER_ID, state.runId);
		expect(run?.status).toBe('settled');
		expect(run?.activeUserId).toBeNull();

		// A later read returns the same terminal state without re-settling.
		const again = isRankedState(await service.get(USER_ID, state.runId));
		expect(again.status).toBe('settled');
		expect(again.balance).toBe(1150);
		expect(spy.calls).toHaveLength(1);
	});

	test('13: SETTLEMENT_CONFLICT leaves the run active and throws a retryable error', async () => {
		const { service, spy, repository } = makeService(randomBytesOf(seedOf(4)));
		spy.setConflict(true);
		const error = await expectServiceError(
			service.start(USER_ID, rankedStart('request-ranked-0001', 100)),
			'SETTLEMENT_CONFLICT',
		);
		expect(error.retryable).toBe(true);

		// The run stays active with its stake debited and no command appended.
		const run = await repository.findActiveRun(USER_ID, 'ranked');
		expect(run?.status).toBe('active');
		expect(run?.activeUserId).toBe(USER_ID);
		expect(run?.commands).toEqual([]);
		expect(await readChipBalance()).toBe(900);
		expect(spy.calls).toHaveLength(1);
	});

	test('14: a later read after the conflict converges and clears active ownership', async () => {
		const { service, spy, repository } = makeService(randomBytesOf(seedOf(4)));
		spy.setConflict(true);
		await expectServiceError(
			service.start(USER_ID, rankedStart('request-ranked-0001', 100)),
			'SETTLEMENT_CONFLICT',
		);

		spy.setConflict(false);
		const state = isRankedState(
			await service.get(USER_ID, (await repository.findActiveRun(USER_ID, 'ranked'))!.id),
		);
		expect(state.status).toBe('settled');
		expect(state.balance).toBe(1150);
		expect(spy.calls).toHaveLength(2);
		expect(spy.calls[0].command.settlementId).toBe(spy.calls[1].command.settlementId);

		const run = await repository.findOwnedRun(USER_ID, state.runId);
		expect(run?.status).toBe('settled');
		expect(run?.activeUserId).toBeNull();

		await expectServiceError(service.current(USER_ID, 'ranked'), 'RUN_NOT_FOUND');
	});

	test('15: expiration settles payout 0 with negative net profit and honors the retry policy', async () => {
		const { service, spy, setNow, repository } = makeService(randomBytesOf(seedOf(13)));
		const state = isRankedState(
			await service.start(USER_ID, rankedStart('request-ranked-0001', 100)),
		);
		await service.command(USER_ID, state.runId, action(0, 'split'));
		expect(await readChipBalance()).toBe(800);

		setNow(NOW_SECONDS + RANKED_TTL_SECONDS + 1);
		const expired = isRankedState(await service.expire(state.runId));
		expect(expired.status).toBe('expired');
		expect(expired.phase).toBe('complete');
		expect(expired.outcome?.payout).toBe(0);
		expect(expired.outcome?.committedWager).toBe(200);
		expect(expired.outcome?.gameNetDelta).toBe(-200);
		expect(expired.balance).toBe(800);
		expect(await readChipBalance()).toBe(800);

		expect(spy.calls).toHaveLength(1);
		expect(spy.calls[0].command).toEqual({
			settlementId: `blackjack-run-${state.runId}`,
			game: 'blackjack',
			delta: 0,
			stats: { rounds: 1, wins: 0, losses: 1, biggestWin: 0, netProfit: -200 },
		});

		const run = await repository.findOwnedRun(USER_ID, state.runId);
		expect(run?.status).toBe('expired');
		expect(run?.activeUserId).toBeNull();
		expect(JSON.parse(run?.resultJson ?? 'null')).toEqual(
			buildExpiryOutcome(
				replayBlackjackRound({ seed: seedOf(13), initialWager: 100, actions: ['split'] }).state,
			),
		);

		// Expiring an already-terminal run is a no-op read.
		const again = isRankedState(await service.expire(state.runId));
		expect(again.status).toBe('expired');
		expect(spy.calls).toHaveLength(1);

		// Same retry policy on expiration: a conflict leaves the run active,
		// and a later read converges.
		await insertTestUser(db, { id: SECOND_USER, chipBalance: 1000 });
		const retry = makeService(randomBytesOf(seedOf(13)));
		const retryRepository = retry.repository;
		const retryRun = isRankedState(
			await retry.service.start(SECOND_USER, rankedStart('request-ranked-0001', 100)),
		);
		await retry.service.command(SECOND_USER, retryRun.runId, action(0, 'split'));
		retry.setNow(NOW_SECONDS + RANKED_TTL_SECONDS + 1);
		retry.spy.setConflict(true);
		await expectServiceError(retry.service.expire(retryRun.runId), 'SETTLEMENT_CONFLICT');
		const stillActive = await retryRepository.findOwnedRun(SECOND_USER, retryRun.runId);
		expect(stillActive?.status).toBe('active');
		expect(stillActive?.activeUserId).toBe(SECOND_USER);
		expect(await readChipBalance(SECOND_USER)).toBe(800);

		retry.spy.setConflict(false);
		const converged = isRankedState(await retry.service.get(SECOND_USER, retryRun.runId));
		expect(converged.status).toBe('expired');
		expect(converged.balance).toBe(800);
		expect(retry.spy.calls).toHaveLength(2);
		expect(retryRepository.findActiveRun(SECOND_USER, 'ranked')).resolves.toBeNull();
	});

	test('a command rejected at expiry finalizes the active run instead of appending', async () => {
		const { service, spy, setNow, repository } = makeService(randomBytesOf(seedOf(13)));
		const state = isRankedState(
			await service.start(USER_ID, rankedStart('request-ranked-0001', 100)),
		);
		const append = repository.appendRankedCommandWithStake.bind(repository);
		let appendCalls = 0;
		repository.appendRankedCommandWithStake = async (input) => {
			appendCalls += 1;
			setNow(state.expiresAt);
			return append({ ...input, nowSeconds: state.expiresAt });
		};

		const expired = isRankedState(await service.command(USER_ID, state.runId, action(0, 'split')));
		expect(appendCalls).toBe(1);
		expect(expired.status).toBe('expired');
		expect(expired.outcome?.committedWager).toBe(100);
		expect(expired.outcome?.gameNetDelta).toBe(-100);
		expect(spy.calls).toHaveLength(1);

		const run = await repository.findOwnedRun(USER_ID, state.runId);
		expect(run?.status).toBe('expired');
		expect(run?.nextSequence).toBe(0);
		expect(run?.commands).toEqual([]);
		expect(await readChipBalance()).toBe(900);
	});
});

// --- Step 4.2: Daily lifecycle tests ---

describe('daily lifecycle', () => {
	test('current period/window drives daily start and current lookups', async () => {
		const { service, spy } = makeService(randomBytesOf(seedOf(0)));
		const state = isDailyState(await service.start(USER_ID, dailyStart('request-daily-0001')));
		expect(state.status).toBe('active');
		expect(state.expiresAt).toBe(NOW_SECONDS + DAILY_TTL_SECONDS);
		expect(state.nextCommandSequence).toBe(0);
		expect(state.availableBankroll).toBe(1000);
		expect(state.terminalReason).toBeNull();

		const current = isDailyState(await service.current(USER_ID, 'daily'));
		expect(current.runId).toBe(state.runId);
		const currentDaily = isDailyState(await service.currentDaily(USER_ID));
		expect(currentDaily.runId).toBe(state.runId);

		await expectServiceError(service.currentDaily(null), 'RUN_NOT_FOUND');
		await expectServiceError(
			service.start(USER_ID, dailyStart('request-daily-0002', '2027-01-14')),
			'INVALID_REQUEST',
		);
		expect(await readChipBalance()).toBe(1000);
		expect(spy.calls).toHaveLength(0);
	});

	test('daily starts before entry close, rejects at and after close, and replays after close', async () => {
		const { service, setNow, repository } = makeService(randomBytesOf(seedOf(0)));
		const entryClose = getDailyWindowForPeriodKey(PERIOD_KEY).rankedEntryClosesAt;
		setNow(entryClose - 1);
		const first = isDailyState(await service.start(USER_ID, dailyStart('request-daily-0001')));
		expect(first.status).toBe('active');

		setNow(entryClose);
		await expectServiceError(
			service.start(USER_ID, dailyStart('request-daily-0002')),
			'INVALID_REQUEST',
		);
		setNow(entryClose + 1);
		await expectServiceError(
			service.start(USER_ID, dailyStart('request-daily-0003')),
			'INVALID_REQUEST',
		);

		const replay = isDailyState(await service.start(USER_ID, dailyStart('request-daily-0001')));
		expect(replay.runId).toBe(first.runId);
		expect(replay.status).toBe('active');
		expect((await repository.findDailyRun(USER_ID, PERIOD_KEY))?.id).toBe(first.runId);
	});

	test('daily users share one lazily-created period seed and replay it deterministically', async () => {
		await insertTestUser(db, { id: SECOND_USER, chipBalance: 1000 });
		const source = randomBytesOf(seedOf(0));
		let randomCalls = 0;
		const { service, repository } = makeService((length) => {
			randomCalls += 1;
			return source(length);
		});

		const first = isDailyState(await service.start(USER_ID, dailyStart('request-daily-0001')));
		const second = isDailyState(await service.start(SECOND_USER, dailyStart('request-daily-0002')));
		const firstRun = await repository.findDailyRun(USER_ID, PERIOD_KEY);
		const secondRun = await repository.findDailyRun(SECOND_USER, PERIOD_KEY);
		expect(firstRun?.seed).toBe(secondRun?.seed);
		expect(randomCalls).toBe(3);

		const definition = await db
			.prepare('SELECT periodKey, seed FROM blackjack_daily WHERE periodKey = ?')
			.bind(PERIOD_KEY)
			.first<{ periodKey: string; seed: string }>();
		expect(definition).toEqual({ periodKey: PERIOD_KEY, seed: firstRun?.seed });
		const count = await db
			.prepare('SELECT COUNT(*) AS count FROM blackjack_daily WHERE periodKey = ?')
			.bind(PERIOD_KEY)
			.first<{ count: number }>();
		expect(count?.count).toBe(1);

		const firstAfterStart = isDailyState(
			await service.command(USER_ID, first.runId, {
				sequence: 0,
				command: 'start-round',
				wager: 10,
			}),
		);
		const secondAfterStart = isDailyState(
			await service.command(SECOND_USER, second.runId, {
				sequence: 0,
				command: 'start-round',
				wager: 10,
			}),
		);
		expect(secondAfterStart.activeRound).toEqual(firstAfterStart.activeRound);
		expect(secondAfterStart.availableBankroll).toBe(firstAfterStart.availableBankroll);

		const firstAfterStand = isDailyState(
			await service.command(USER_ID, first.runId, { sequence: 1, command: 'stand' }),
		);
		const secondAfterStand = isDailyState(
			await service.command(SECOND_USER, second.runId, { sequence: 1, command: 'stand' }),
		);
		expect(secondAfterStand.availableBankroll).toBe(firstAfterStand.availableBankroll);
		expect(secondAfterStand.roundsCompleted).toBe(firstAfterStand.roundsCompleted);
	});

	test('exactly one attempt per period', async () => {
		const { service } = makeService(randomBytesOf(seedOf(0)));
		const first = isDailyState(await service.start(USER_ID, dailyStart('request-daily-0001')));
		// Same request ID replays the same run.
		const replay = isDailyState(await service.start(USER_ID, dailyStart('request-daily-0001')));
		expect(replay.runId).toBe(first.runId);
		// A different request ID still resolves to the one attempt.
		const second = isDailyState(await service.start(USER_ID, dailyStart('request-daily-0002')));
		expect(second.runId).toBe(first.runId);

		const rows = await db
			.prepare('SELECT COUNT(*) AS count FROM blackjack_run WHERE userId = ?')
			.bind(USER_ID)
			.first<{ count: number }>();
		expect(rows?.count).toBe(1);
		expect(await readChipBalance()).toBe(1000);
	});

	test('virtual bankroll actions move the run bankroll and never touch the wallet', async () => {
		const { service, spy } = makeService(randomBytesOf(seedOf(10)));
		const state = isDailyState(await service.start(USER_ID, dailyStart('request-daily-0001')));

		const afterStart = isDailyState(
			await service.command(USER_ID, state.runId, {
				sequence: 0,
				command: 'start-round',
				wager: 100,
			}),
		);
		expect(afterStart.nextCommandSequence).toBe(1);
		expect(afterStart.availableBankroll).toBe(900);
		expect(afterStart.activeRound).not.toBeNull();

		// Round 0 of master seed 10 is double-down legal; the additional stake
		// comes out of the virtual bankroll (1000 - 100 - 100 + 0 payout = 800).
		const afterDouble = isDailyState(
			await service.command(USER_ID, state.runId, { sequence: 1, command: 'double-down' }),
		);
		expect(afterDouble.roundsCompleted).toBe(1);
		expect(afterDouble.availableBankroll).toBe(800);
		expect(afterDouble.activeRound).toBeNull();

		expect(await readChipBalance()).toBe(1000);
		expect(spy.calls).toHaveLength(0);
	});

	test('the full Daily lifecycle never calls the wallet', async () => {
		const { service, spy } = makeService(randomBytesOf(seedOf(0)));
		const state = isDailyState(await service.start(USER_ID, dailyStart('request-daily-0001')));
		for (const command of buildDailyStandLog(seedOf(0), 10)) {
			await service.command(USER_ID, state.runId, command);
		}
		const terminal = isDailyState(await service.get(USER_ID, state.runId));
		expect(terminal.status).toBe('completed');
		expect(await readChipBalance()).toBe(1000);
		expect(spy.calls).toHaveLength(0);
	});

	test('eligible completion writes leaderboard projections and standing', async () => {
		const { service, spy, repository } = makeService(randomBytesOf(seedOf(0)));
		const state = isDailyState(await service.start(USER_ID, dailyStart('request-daily-0001')));
		const log = buildDailyStandLog(seedOf(0), 10);
		for (let index = 0; index < log.length; index += 1) {
			const intermediate = isDailyState(await service.command(USER_ID, state.runId, log[index]));
			expect(intermediate.nextCommandSequence).toBe(index + 1);
		}
		const terminal = isDailyState(await service.get(USER_ID, state.runId));
		expect(terminal.status).toBe('completed');
		expect(terminal.terminalReason).toBe('completed');
		expect(terminal.eligible).toBe(true);
		expect(terminal.roundsCompleted).toBe(10);
		expect(terminal.availableBankroll).toBe(980);
		expect(terminal.activeRound).toBeNull();
		expect(terminal.rank).toBe(1);
		expect(terminal.percentile).toBe(100);

		const run = await repository.findDailyRun(USER_ID, PERIOD_KEY);
		expect(run?.status).toBe('completed');
		expect(run?.dailyEndingBankroll).toBe(980);
		expect(run?.dailyRoundsCompleted).toBe(10);

		const leaderboard = await service.leaderboard(PERIOD_KEY, null, 50);
		expect(leaderboard.entries).toEqual([
			{
				rank: 1,
				userId: USER_ID,
				playerName: `Test ${USER_ID}`,
				dailyEndingBankroll: 980,
				dailyRoundsCompleted: 10,
				settledAt: expect.any(Number) as unknown as number,
			},
		]);
		expect(leaderboard.currentUser).toBeNull();
		expect(spy.calls).toHaveLength(0);
	});

	test('bankroll-below-minimum completion is still an eligible terminal', async () => {
		const { service } = makeService(randomBytesOf(seedOf(0)));
		const state = isDailyState(await service.start(USER_ID, dailyStart('request-daily-0001')));
		await service.command(USER_ID, state.runId, {
			sequence: 0,
			command: 'start-round',
			wager: 1000,
		});
		const terminal = isDailyState(
			await service.command(USER_ID, state.runId, { sequence: 1, command: 'stand' }),
		);
		expect(terminal.status).toBe('completed');
		expect(terminal.terminalReason).toBe('bankroll-below-minimum');
		expect(terminal.eligible).toBe(true);
		expect(terminal.roundsCompleted).toBe(1);
		expect(terminal.availableBankroll).toBe(0);
		expect(terminal.rank).toBe(1);
		expect(terminal.percentile).toBe(100);

		const leaderboard = await service.leaderboard(PERIOD_KEY, null, 50);
		expect(leaderboard.entries.map((entry) => entry.userId)).toEqual([USER_ID]);
		expect(await readChipBalance()).toBe(1000);
	});

	test('forfeit ends the attempt without leaderboard eligibility', async () => {
		const { service, spy, repository } = makeService(randomBytesOf(seedOf(0)));
		const state = isDailyState(await service.start(USER_ID, dailyStart('request-daily-0001')));
		const forfeited = isDailyState(
			await service.command(USER_ID, state.runId, { sequence: 0, command: 'forfeit' }),
		);
		expect(forfeited.status).toBe('forfeited');
		expect(forfeited.terminalReason).toBe('forfeited');
		expect(forfeited.eligible).toBe(false);
		expect(forfeited.activeRound).toBeNull();

		const run = await repository.findDailyRun(USER_ID, PERIOD_KEY);
		expect(run?.status).toBe('forfeited');
		expect(run?.dailyEndingBankroll).toBeNull();
		expect(run?.dailyRoundsCompleted).toBeNull();

		const leaderboard = await service.leaderboard(PERIOD_KEY, null, 50);
		expect(leaderboard.entries).toEqual([]);

		// Commands against a terminal attempt replay the terminal state.
		const replay = isDailyState(
			await service.command(USER_ID, state.runId, {
				sequence: 1,
				command: 'start-round',
				wager: 100,
			}),
		);
		expect(replay.status).toBe('forfeited');
		expect(await readChipBalance()).toBe(1000);
		expect(spy.calls).toHaveLength(0);
	});

	test('expiration stores expired with null projections and no wallet call', async () => {
		const { service, spy, setNow, repository } = makeService(randomBytesOf(seedOf(0)));
		const state = isDailyState(await service.start(USER_ID, dailyStart('request-daily-0001')));
		setNow(NOW_SECONDS + DAILY_TTL_SECONDS + 1);
		const expired = isDailyState(await service.expire(state.runId));
		expect(expired.status).toBe('expired');
		expect(expired.terminalReason).toBe('expired');
		expect(expired.eligible).toBeNull();
		expect(expired.activeRound).toBeNull();
		expect(expired.availableBankroll).toBe(1000);
		expect(expired.roundsCompleted).toBe(0);
		expect(expired.rank).toBeNull();
		expect(expired.percentile).toBeNull();

		const run = await repository.findDailyRun(USER_ID, PERIOD_KEY);
		expect(run?.status).toBe('expired');
		expect(run?.dailyEndingBankroll).toBeNull();
		expect(run?.dailyRoundsCompleted).toBeNull();

		// current() converges on the expired row too.
		const current = isDailyState(await service.current(USER_ID, 'daily'));
		expect(current.status).toBe('expired');
		const leaderboard = await service.leaderboard(PERIOD_KEY, null, 50);
		expect(leaderboard.entries).toEqual([]);
		expect(await readChipBalance()).toBe(1000);
		expect(spy.calls).toHaveLength(0);
	});

	test('current returns the terminal run after completion', async () => {
		const { service } = makeService(randomBytesOf(seedOf(0)));
		const state = isDailyState(await service.start(USER_ID, dailyStart('request-daily-0001')));
		for (const command of buildDailyStandLog(seedOf(0), 10)) {
			await service.command(USER_ID, state.runId, command);
		}
		const current = isDailyState(await service.current(USER_ID, 'daily'));
		expect(current.runId).toBe(state.runId);
		expect(current.status).toBe('completed');
		expect(current.rank).toBe(1);
		expect(current.percentile).toBe(100);
	});

	test('rank/percentile standing covers multiple eligible players', async () => {
		await insertTestUser(db, { id: SECOND_USER, chipBalance: 1000 });
		const first = makeService(randomBytesOf(seedOf(0)));
		const firstState = isDailyState(
			await first.service.start(USER_ID, dailyStart('request-daily-0001')),
		);
		for (const command of buildDailyStandLog(seedOf(0), 10)) {
			await first.service.command(USER_ID, firstState.runId, command);
		}

		const second = makeService(randomBytesOf(seedOf(0)));
		const secondState = isDailyState(
			await second.service.start(SECOND_USER, dailyStart('request-daily-0001')),
		);
		await second.service.command(SECOND_USER, secondState.runId, {
			sequence: 0,
			command: 'start-round',
			wager: 1000,
		});
		await second.service.command(SECOND_USER, secondState.runId, {
			sequence: 1,
			command: 'stand',
		});

		const leaderboard = await first.service.leaderboard(PERIOD_KEY, null, 50);
		expect(leaderboard.entries.map((entry) => [entry.userId, entry.rank])).toEqual([
			[USER_ID, 1],
			[SECOND_USER, 2],
		]);
		const standingA = await first.service.leaderboard(PERIOD_KEY, USER_ID, 50);
		expect(standingA.currentUser).toEqual({ rank: 1, totalEligible: 2, percentile: 100 });
		const standingB = await first.service.leaderboard(PERIOD_KEY, SECOND_USER, 50);
		expect(standingB.currentUser).toEqual({ rank: 2, totalEligible: 2, percentile: 50 });
		expect(await readChipBalance()).toBe(1000);
		expect(await readChipBalance(SECOND_USER)).toBe(1000);
	});
});
