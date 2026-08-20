import { describe, expect, test } from 'bun:test';
import type { Card, Rank, Suit } from '../blackjack/types';
import {
	calculateDailyPercentile,
	compareDailyScores,
	DAILY_RUN_CONFIG,
	deriveDailyRoundSeed,
	getDailyPeriodKey,
	getDailyWindow,
	getDailyWindowForPeriodKey,
	getDailyWeekWindow,
	replayDailyRun,
	type DailyScore,
} from './daily';
import type { BlackjackRunCommand } from './protocol';

const SUITS: readonly Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS: readonly Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function card(rank: Rank, suit: Suit): Card {
	return { rank, suit };
}

function startRound(sequence: number, wager: number): BlackjackRunCommand {
	return { sequence, command: 'start-round', wager };
}

function cmd(sequence: number, command: 'hit' | 'stand' | 'double-down' | 'split' | 'forfeit') {
	return { sequence, command } as BlackjackRunCommand;
}

function deckWithDraws(...draws: readonly Card[]): Card[] {
	const canonicalDeck = SUITS.flatMap((suit) => RANKS.map((rank) => card(rank, suit)));
	const drawKeys = new Set(draws.map(({ rank, suit }) => `${rank}:${suit}`));
	expect(drawKeys.size).toBe(draws.length);
	return [
		...canonicalDeck.filter(({ rank, suit }) => !drawKeys.has(`${rank}:${suit}`)),
		...[...draws].reverse(),
	];
}

const MASTER_SEED = Uint8Array.from({ length: 32 }, (_, index) => index);
const FIXED_SEED = Uint8Array.from({ length: 32 }, (_, index) => (index + 2) % 256);

function singleDeckSource(deck: Card[]): (roundIndex: number) => Card[] {
	return () => deck;
}

function expectDailyError(code: string, fn: () => unknown): void {
	try {
		fn();
	} catch (error) {
		expect((error as { code?: string }).code).toBe(code);
		return;
	}
	throw new Error(`Expected a Daily error with code ${code}, but none was thrown`);
}

describe('replayDailyRun round segmentation', () => {
	test('maps global commands to fresh per-round action sequences', () => {
		const commands: BlackjackRunCommand[] = [
			startRound(0, 10),
			cmd(1, 'stand'),
			startRound(2, 20),
			cmd(3, 'hit'),
			cmd(4, 'stand'),
		];

		const replay = replayDailyRun(FIXED_SEED, commands);

		expect(replay.nextCommandSequence).toBe(5);
		expect(replay.roundsCompleted).toBe(2);
		expect(replay.rounds[0].actions).toEqual(['stand']);
		expect(replay.rounds[1].actions).toEqual(['hit', 'stand']);
	});
});

describe('replayDailyRun bankroll and wager handling', () => {
	test('deducts the initial wager when a round starts and keeps the round active', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);

		const replay = replayDailyRun(MASTER_SEED, [startRound(0, 100)], singleDeckSource(deck));

		expect(replay.availableBankroll).toBe(900);
		expect(replay.roundsCompleted).toBe(0);
		expect(replay.status).toBe('active');
		expect(replay.activeRound?.initialWager).toBe(100);
		expect(replay.activeRound?.actions).toEqual([]);
		expect(replay.activeRoundPublic).not.toBeNull();
		expect((replay.activeRoundPublic as { nextSequence?: number }).nextSequence).toBeUndefined();
	});

	test('credits the gross payout for a win', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('Q', 'diamonds'),
			card('10', 'clubs'),
			card('8', 'spades'),
		);

		const replay = replayDailyRun(
			MASTER_SEED,
			[startRound(0, 100), cmd(1, 'stand')],
			singleDeckSource(deck),
		);

		expect(replay.roundsCompleted).toBe(1);
		expect(replay.availableBankroll).toBe(1100);
		expect(replay.rounds[0].replay.outcome?.result).toBe('win');
	});

	test('credits only the wager back on a push', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);

		const replay = replayDailyRun(
			MASTER_SEED,
			[startRound(0, 100), cmd(1, 'stand')],
			singleDeckSource(deck),
		);

		expect(replay.roundsCompleted).toBe(1);
		expect(replay.availableBankroll).toBe(1000);
		expect(replay.rounds[0].replay.outcome?.result).toBe('push');
	});

	test('forfeits the committed wager on a loss', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('10', 'clubs'),
			card('Q', 'spades'),
		);

		const replay = replayDailyRun(
			MASTER_SEED,
			[startRound(0, 100), cmd(1, 'stand')],
			singleDeckSource(deck),
		);

		expect(replay.roundsCompleted).toBe(1);
		expect(replay.availableBankroll).toBe(900);
		expect(replay.rounds[0].replay.outcome?.result).toBe('loss');
	});

	test('settles a natural Blackjack on start-round with odd-wager 3:2 profit flooring', () => {
		const deck = deckWithDraws(
			card('A', 'hearts'),
			card('K', 'spades'),
			card('10', 'diamonds'),
			card('9', 'clubs'),
		);

		const replay = replayDailyRun(MASTER_SEED, [startRound(0, 15)], singleDeckSource(deck));

		expect(replay.roundsCompleted).toBe(1);
		expect(replay.rounds[0].actions).toEqual([]);
		expect(replay.rounds[0].replay.outcome?.hands[0]).toMatchObject({
			result: 'blackjack',
			payout: 37,
		});
		expect(replay.availableBankroll).toBe(1022);
		expect(replay.activeRound).toBeNull();
	});

	test('deducts and credits a double-down against the bankroll invariant', () => {
		const deck = deckWithDraws(
			card('5', 'hearts'),
			card('6', 'diamonds'),
			card('10', 'clubs'),
			card('7', 'spades'),
			card('10', 'hearts'),
		);

		const replay = replayDailyRun(
			MASTER_SEED,
			[startRound(0, 10), cmd(1, 'double-down')],
			singleDeckSource(deck),
		);

		const settlement = replay.rounds[0];
		expect(settlement.replay.outcome?.committedWager).toBe(20);
		expect(settlement.replay.outcome?.payout).toBe(40);
		expect(replay.availableBankroll).toBe(
			DAILY_RUN_CONFIG.startingBankroll -
				(settlement.replay.outcome as { committedWager: number }).committedWager +
				(settlement.replay.outcome as { payout: number }).payout,
		);
	});

	test('deducts split additional wagers and settles both hands', () => {
		const deck = deckWithDraws(
			card('8', 'hearts'),
			card('8', 'diamonds'),
			card('6', 'hearts'),
			card('10', 'clubs'),
			card('10', 'hearts'),
			card('9', 'hearts'),
			card('10', 'diamonds'),
			card('2', 'clubs'),
		);

		const replay = replayDailyRun(
			MASTER_SEED,
			[startRound(0, 100), cmd(1, 'split'), cmd(2, 'stand'), cmd(3, 'hit')],
			singleDeckSource(deck),
		);

		const settlement = replay.rounds[0];
		expect(settlement.replay.outcome?.committedWager).toBe(200);
		expect(settlement.replay.outcome?.payout).toBe(100);
		expect(replay.availableBankroll).toBe(900);
		expect(replay.rounds[0].actions).toEqual(['split', 'stand', 'hit']);
	});
});

describe('replayDailyRun terminal precedence', () => {
	const lossDeck = () =>
		deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('10', 'clubs'),
			card('Q', 'spades'),
		);

	test('completes with bankroll-below-minimum before all rounds finish', () => {
		const commands: BlackjackRunCommand[] = [];
		for (let round = 0; round < 5; round += 1) {
			commands.push(startRound(round * 2, 200));
			commands.push(cmd(round * 2 + 1, 'stand'));
		}

		const replay = replayDailyRun(MASTER_SEED, commands, singleDeckSource(lossDeck()));

		expect(replay.roundsCompleted).toBe(5);
		expect(replay.availableBankroll).toBe(0);
		expect(replay.status).toBe('completed');
		expect(replay.terminalReason).toBe('bankroll-below-minimum');
		expect(replay.eligible).toBe(true);
	});

	test('round-count completion wins over a sub-minimum bankroll', () => {
		const commands: BlackjackRunCommand[] = [];
		for (let round = 0; round < 10; round += 1) {
			commands.push(startRound(round * 2, 100));
			commands.push(cmd(round * 2 + 1, 'stand'));
		}

		const replay = replayDailyRun(MASTER_SEED, commands, singleDeckSource(lossDeck()));

		expect(replay).toMatchObject({
			status: 'completed',
			terminalReason: 'completed',
			eligible: true,
			roundsCompleted: 10,
		});
		expect(replay.availableBankroll).toBe(0);
	});

	test('an accepted forfeit is ineligible and never reaches the engine', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);

		const replay = replayDailyRun(
			MASTER_SEED,
			[startRound(0, 100), cmd(1, 'forfeit')],
			singleDeckSource(deck),
		);

		expect(replay).toMatchObject({
			status: 'forfeited',
			terminalReason: 'forfeited',
			eligible: false,
			nextCommandSequence: 2,
		});
		expect(replay.activeRound?.actions).toEqual([]);
		expect(replay.activeRoundPublic).toBeNull();
	});
});

describe('replayDailyRun error handling and determinism', () => {
	test('rejects a static wager below the configured minimum', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);

		expectDailyError('INVALID_WAGER', () =>
			replayDailyRun(MASTER_SEED, [startRound(0, 5)], singleDeckSource(deck)),
		);
	});

	test('rejects a static wager above the configured maximum', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);

		expectDailyError('INVALID_WAGER', () =>
			replayDailyRun(MASTER_SEED, [startRound(0, 1500)], singleDeckSource(deck)),
		);
	});

	test('rejects a dynamic double-down funding gap with a distinct error', () => {
		const deck = deckWithDraws(
			card('5', 'hearts'),
			card('6', 'diamonds'),
			card('10', 'clubs'),
			card('7', 'spades'),
		);

		expectDailyError('INSUFFICIENT_CHALLENGE_BANKROLL', () =>
			replayDailyRun(
				MASTER_SEED,
				[startRound(0, 600), cmd(1, 'double-down')],
				singleDeckSource(deck),
			),
		);
	});

	test('rejects a non-contiguous command sequence', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);

		expectDailyError('SEQUENCE_MISMATCH', () =>
			replayDailyRun(MASTER_SEED, [startRound(5, 100)], singleDeckSource(deck)),
		);
	});

	test('rejects a start-round command while a round is still active', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);

		expectDailyError('INVALID_COMMAND', () =>
			replayDailyRun(MASTER_SEED, [startRound(0, 100), startRound(1, 100)], singleDeckSource(deck)),
		);
	});

	test('rejects a blackjack action issued with no active round', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);

		expectDailyError('INVALID_COMMAND', () =>
			replayDailyRun(MASTER_SEED, [cmd(0, 'stand')], singleDeckSource(deck)),
		);
	});

	test('is byte-identical for identical inputs', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);
		const commands: BlackjackRunCommand[] = [startRound(0, 100), cmd(1, 'stand')];

		const first = replayDailyRun(MASTER_SEED, commands, singleDeckSource(deck));
		const second = replayDailyRun(MASTER_SEED, commands, singleDeckSource(deck));

		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});
});

describe('replayDailyRun terminal guard errors', () => {
	const lossDeck = () =>
		deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('10', 'clubs'),
			card('Q', 'spades'),
		);

	test('rejects a start-round command after the run is terminal', () => {
		const commands: BlackjackRunCommand[] = [];
		for (let round = 0; round < 5; round += 1) {
			commands.push(startRound(round * 2, 200));
			commands.push(cmd(round * 2 + 1, 'stand'));
		}
		commands.push(startRound(10, 200));

		expectDailyError('ATTEMPT_COMPLETE', () =>
			replayDailyRun(MASTER_SEED, commands, singleDeckSource(lossDeck())),
		);
	});

	test('rejects a blackjack action after the run is terminal', () => {
		const commands: BlackjackRunCommand[] = [];
		for (let round = 0; round < 5; round += 1) {
			commands.push(startRound(round * 2, 200));
			commands.push(cmd(round * 2 + 1, 'stand'));
		}
		commands.push(cmd(10, 'stand'));

		expectDailyError('ATTEMPT_COMPLETE', () =>
			replayDailyRun(MASTER_SEED, commands, singleDeckSource(lossDeck())),
		);
	});

	test('rejects a start-round wager exceeding the available bankroll', () => {
		expectDailyError('INSUFFICIENT_CHALLENGE_BANKROLL', () =>
			replayDailyRun(
				MASTER_SEED,
				[startRound(0, 600), cmd(1, 'stand'), startRound(2, 500)],
				singleDeckSource(lossDeck()),
			),
		);
	});

	test('rejects a blackjack action that is not in the legal actions', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);

		expectDailyError('INVALID_COMMAND', () =>
			replayDailyRun(MASTER_SEED, [startRound(0, 100), cmd(1, 'split')], singleDeckSource(deck)),
		);
	});
});

describe('DAILY_RUN_CONFIG', () => {
	test('pins the immutable daily constants', () => {
		expect(DAILY_RUN_CONFIG).toEqual({
			startingBankroll: 1000,
			roundCount: 10,
			minimumWager: 10,
			maximumWager: 1000,
			attemptTtlSeconds: 1800,
			rankedEntryCloseOffsetSeconds: 1800,
		});
	});

	test('is frozen immutable', () => {
		expect(Object.isFrozen(DAILY_RUN_CONFIG)).toBe(true);
	});

	test('exposes a 30-minute attempt TTL and entry cutoff', () => {
		expect(DAILY_RUN_CONFIG.attemptTtlSeconds).toBe(30 * 60);
		expect(DAILY_RUN_CONFIG.rankedEntryCloseOffsetSeconds).toBe(30 * 60);
	});
});

describe('getDailyPeriodKey', () => {
	test('re-exports the UTC calendar-day period key helper', () => {
		expect(getDailyPeriodKey(new Date('2026-03-14T12:30:00Z'))).toBe('2026-03-14');
		expect(getDailyPeriodKey(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12-31');
	});
});

describe('getDailyWindow', () => {
	test('aligns a midday timestamp to the UTC midnight window', () => {
		const window = getDailyWindow(Date.UTC(2026, 2, 14, 12, 30, 0) / 1000);
		expect(window).toEqual({
			periodKey: '2026-03-14',
			startsAt: Date.UTC(2026, 2, 14) / 1000,
			rankedEntryClosesAt: Date.UTC(2026, 2, 14) / 1000 + 24 * 60 * 60 - 1800,
			endsAt: Date.UTC(2026, 2, 14) / 1000 + 24 * 60 * 60,
		});
	});

	test('handles leap day', () => {
		const window = getDailyWindow(Date.UTC(2024, 1, 29, 23, 59, 59) / 1000);
		expect(window.periodKey).toBe('2024-02-29');
		expect(window.endsAt).toBe(Date.UTC(2024, 2, 1) / 1000);
	});

	test('handles month end', () => {
		const window = getDailyWindow(Date.UTC(2026, 3, 30, 0, 0, 0) / 1000);
		expect(window.periodKey).toBe('2026-04-30');
		expect(window.endsAt).toBe(Date.UTC(2026, 4, 1) / 1000);
	});

	test('handles year end into a new year', () => {
		const window = getDailyWindow(Date.UTC(2026, 11, 31, 23, 30, 0) / 1000);
		expect(window.periodKey).toBe('2026-12-31');
		expect(window.endsAt).toBe(Date.UTC(2027, 0, 1) / 1000);
	});

	test('ranks entry closes 1800s before the window ends', () => {
		const window = getDailyWindow(Date.UTC(2026, 0, 1, 23, 30, 0) / 1000);
		expect(window.endsAt - window.rankedEntryClosesAt).toBe(1800);
	});

	test('exactly midnight resolves to the same UTC day window', () => {
		const midnight = Date.UTC(2026, 5, 15, 0, 0, 0) / 1000;
		const window = getDailyWindow(midnight);
		expect(window.startsAt).toBe(midnight);
		expect(window.endsAt).toBe(midnight + 24 * 60 * 60);
	});

	test.each([
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
		Number.MAX_SAFE_INTEGER,
	])('rejects an invalid now value %p', (nowSeconds) => {
		expect(() => getDailyWindow(nowSeconds)).toThrow();
	});
});

describe('getDailyWindowForPeriodKey', () => {
	test('derives the same window as getDailyWindow for a known period key', () => {
		const nowSeconds = Date.UTC(2026, 2, 14, 12, 30, 0) / 1000;
		const viaNow = getDailyWindow(nowSeconds);
		const viaKey = getDailyWindowForPeriodKey('2026-03-14');
		expect(viaKey).toEqual(viaNow);
	});

	test('aligns startsAt to UTC midnight and endsAt 24h later', () => {
		const window = getDailyWindowForPeriodKey('2026-03-14');
		expect(window.startsAt).toBe(Date.UTC(2026, 2, 14) / 1000);
		expect(window.endsAt).toBe(Date.UTC(2026, 2, 15) / 1000);
		expect(window.endsAt - window.rankedEntryClosesAt).toBe(1800);
	});

	test('handles leap day', () => {
		const window = getDailyWindowForPeriodKey('2024-02-29');
		expect(window.startsAt).toBe(Date.UTC(2024, 1, 29) / 1000);
		expect(window.endsAt).toBe(Date.UTC(2024, 2, 1) / 1000);
	});

	test.each([
		'not-a-date',
		'2025-13-01',
		'2025-00-10',
		'2025-02-30',
		'2025-04-31',
		'2025-06-31',
		'2025-09-31',
		'2025-11-31',
		'20250615',
		'',
		'2025-6-5',
	])('rejects an invalid or non-existent calendar date %p', (periodKey) => {
		expect(() => getDailyWindowForPeriodKey(periodKey)).toThrow();
	});
});

describe('deriveDailyRoundSeed', () => {
	const seed = Uint8Array.from({ length: 32 }, (_, index) => index);

	function bytesToHex(bytes: Uint8Array): string {
		return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
	}

	test('pins the round-seed hex vectors for known indexes', () => {
		expect(bytesToHex(deriveDailyRoundSeed(seed, 0))).toBe(
			'8dc9777279bdc9941c3b19561bf0f18e43c4eefdc965e3d8603778be1a2feb89',
		);
		expect(bytesToHex(deriveDailyRoundSeed(seed, 1))).toBe(
			'15db94f87b0320085e98f53066cbe8d12360d8a2dabd65a337008f6e83a632ff',
		);
		expect(bytesToHex(deriveDailyRoundSeed(seed, 9))).toBe(
			'4a845fbca75e47fe4f544e06713aa47cad29aa980ab28375e7fda835f9b31fd0',
		);
	});

	test('produces distinct 32-byte round seeds across consecutive indexes', () => {
		const zero = bytesToHex(deriveDailyRoundSeed(seed, 0));
		const one = bytesToHex(deriveDailyRoundSeed(seed, 1));
		const nine = bytesToHex(deriveDailyRoundSeed(seed, 9));
		expect(zero).not.toBe(one);
		expect(one).not.toBe(nine);
		expect(deriveDailyRoundSeed(seed, 0)).toHaveLength(32);
	});

	test('derives identical output for the same inputs (deterministic)', () => {
		expect(deriveDailyRoundSeed(seed, 4)).toEqual(deriveDailyRoundSeed(seed, 4));
	});

	test.each([new Uint8Array(), new Uint8Array(31), new Uint8Array(33)])(
		'rejects a master seed that is not exactly 32 bytes (%p bytes)',
		(invalidSeed) => {
			expect(() => deriveDailyRoundSeed(invalidSeed, 0)).toThrow();
		},
	);

	test.each([-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
		'rejects an invalid round index %p',
		(roundIndex) => {
			expect(() => deriveDailyRoundSeed(seed, roundIndex)).toThrow();
		},
	);
});

describe('compareDailyScores', () => {
	test('ranks the higher ending bankroll first', () => {
		const left: DailyScore = { endingBankroll: 1100, roundsCompleted: 5 };
		const right: DailyScore = { endingBankroll: 900, roundsCompleted: 10 };

		expect(compareDailyScores(left, right)).toBeLessThan(0);
	});

	test('breaks a bankroll tie by more rounds completed', () => {
		const left: DailyScore = { endingBankroll: 1000, roundsCompleted: 5 };
		const right: DailyScore = { endingBankroll: 1000, roundsCompleted: 9 };

		expect(compareDailyScores(left, right)).toBeGreaterThan(0);
	});

	test('returns zero for identical scores', () => {
		const score: DailyScore = { endingBankroll: 1000, roundsCompleted: 10 };

		expect(compareDailyScores(score, { ...score })).toBe(0);
	});
});

describe('calculateDailyPercentile', () => {
	test('assigns 100 to the top of the population', () => {
		expect(calculateDailyPercentile(100, 0)).toBe(100);
	});

	test('assigns 1 to the bottom of the population', () => {
		expect(calculateDailyPercentile(100, 99)).toBe(1);
	});

	test('rounds an intermediate ratio to the nearest whole percentile', () => {
		expect(calculateDailyPercentile(3, 1)).toBe(67);
	});

	test('assigns 100 to the sole eligible player', () => {
		expect(calculateDailyPercentile(1, 0)).toBe(100);
	});

	test.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
		'rejects an invalid totalEligible (%p)',
		(totalEligible) => {
			expect(() => calculateDailyPercentile(totalEligible, 0)).toThrow(RangeError);
		},
	);

	test.each([-1, 0.5])(
		'rejects a negative or fractional playersStrictlyAbove (%p)',
		(playersStrictlyAbove) => {
			expect(() => calculateDailyPercentile(10, playersStrictlyAbove)).toThrow(RangeError);
		},
	);

	test.each([10, 11])(
		'rejects playersStrictlyAbove at or above totalEligible (%p)',
		(playersStrictlyAbove) => {
			expect(() => calculateDailyPercentile(10, playersStrictlyAbove)).toThrow(RangeError);
		},
	);
});

describe('getDailyWeekWindow', () => {
	test('uses Monday 00:00 UTC through the next Monday', () => {
		const now = Math.trunc(Date.parse('2026-08-17T00:00:00.000Z') / 1000);
		expect(getDailyWeekWindow(now)).toEqual({
			startPeriodKey: '2026-08-17',
			endPeriodKeyExclusive: '2026-08-24',
		});
	});

	test('keeps Sunday night inside the same range', () => {
		const now = Math.trunc(Date.parse('2026-08-23T23:59:59.000Z') / 1000);
		expect(getDailyWeekWindow(now)).toEqual({
			startPeriodKey: '2026-08-17',
			endPeriodKeyExclusive: '2026-08-24',
		});
	});

	test('rolls over exactly at next Monday UTC', () => {
		const now = Math.trunc(Date.parse('2026-08-24T00:00:00.000Z') / 1000);
		expect(getDailyWeekWindow(now)).toEqual({
			startPeriodKey: '2026-08-24',
			endPeriodKeyExclusive: '2026-08-31',
		});
	});

	test('uses calendar date boundaries across ISO week-year rollover', () => {
		const now = Math.trunc(Date.parse('2027-01-01T12:00:00.000Z') / 1000);
		expect(getDailyWeekWindow(now)).toEqual({
			startPeriodKey: '2026-12-28',
			endPeriodKeyExclusive: '2027-01-04',
		});
	});

	test('rejects invalid timestamps', () => {
		expect(() => getDailyWeekWindow(-1)).toThrow(TypeError);
		expect(() => getDailyWeekWindow(Number.POSITIVE_INFINITY)).toThrow(TypeError);
	});
});
