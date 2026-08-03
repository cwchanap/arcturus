import { describe, expect, test } from 'bun:test';
import type { Card, Rank, Suit } from '../blackjack/types';
import { BLACKJACK_DAILY_V1_CONFIG } from './config';
import { type DailyChallengeCommandV1 } from './protocol';
import { replayDailyChallenge } from './replay';

const SUITS: readonly Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS: readonly Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function card(rank: Rank, suit: Suit): Card {
	return { rank, suit };
}

function startRound(sequence: number, wager: number): DailyChallengeCommandV1 {
	return { sequence, command: 'start-round', wager };
}

function cmd(sequence: number, command: 'hit' | 'stand' | 'double-down' | 'split' | 'forfeit') {
	return { sequence, command } as DailyChallengeCommandV1;
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
	throw new Error(`Expected a Daily Challenge error with code ${code}, but none was thrown`);
}

describe('replayDailyChallenge round segmentation', () => {
	test('maps global commands to fresh per-round adapter action sequences', () => {
		const commands: DailyChallengeCommandV1[] = [
			startRound(0, 10),
			cmd(1, 'stand'),
			startRound(2, 20),
			cmd(3, 'hit'),
			cmd(4, 'stand'),
		];

		const replay = replayDailyChallenge(BLACKJACK_DAILY_V1_CONFIG, FIXED_SEED, commands);

		expect(replay.nextCommandSequence).toBe(5);
		expect(replay.roundsCompleted).toBe(2);
		expect(replay.rounds[0].adapterActions.map((entry) => entry.sequence)).toEqual([0]);
		expect(replay.rounds[1].adapterActions.map((entry) => entry.sequence)).toEqual([0, 1]);
	});
});

describe('replayDailyChallenge bankroll and wager handling', () => {
	test('deducts the initial wager when a round starts and keeps the round active', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);

		const replay = replayDailyChallenge(
			BLACKJACK_DAILY_V1_CONFIG,
			MASTER_SEED,
			[startRound(0, 100)],
			singleDeckSource(deck),
		);

		expect(replay.availableBankroll).toBe(900);
		expect(replay.roundsCompleted).toBe(0);
		expect(replay.status).toBe('active');
		expect(replay.activeRound?.initialWager).toBe(100);
		expect(replay.activeRound?.adapterActions).toEqual([]);
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

		const replay = replayDailyChallenge(
			BLACKJACK_DAILY_V1_CONFIG,
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

		const replay = replayDailyChallenge(
			BLACKJACK_DAILY_V1_CONFIG,
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

		const replay = replayDailyChallenge(
			BLACKJACK_DAILY_V1_CONFIG,
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

		const replay = replayDailyChallenge(
			BLACKJACK_DAILY_V1_CONFIG,
			MASTER_SEED,
			[startRound(0, 15)],
			singleDeckSource(deck),
		);

		expect(replay.roundsCompleted).toBe(1);
		expect(replay.rounds[0].adapterActions).toEqual([]);
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

		const replay = replayDailyChallenge(
			BLACKJACK_DAILY_V1_CONFIG,
			MASTER_SEED,
			[startRound(0, 10), cmd(1, 'double-down')],
			singleDeckSource(deck),
		);

		const settlement = replay.rounds[0];
		expect(settlement.replay.outcome?.committedWager).toBe(20);
		expect(settlement.replay.outcome?.payout).toBe(40);
		expect(replay.availableBankroll).toBe(
			BLACKJACK_DAILY_V1_CONFIG.startingBankroll -
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

		const replay = replayDailyChallenge(
			BLACKJACK_DAILY_V1_CONFIG,
			MASTER_SEED,
			[startRound(0, 100), cmd(1, 'split'), cmd(2, 'stand'), cmd(3, 'hit')],
			singleDeckSource(deck),
		);

		const settlement = replay.rounds[0];
		expect(settlement.replay.outcome?.committedWager).toBe(200);
		expect(settlement.replay.outcome?.payout).toBe(100);
		expect(replay.availableBankroll).toBe(900);
		expect(replay.rounds[0].adapterActions.map((entry) => entry.sequence)).toEqual([0, 1, 2]);
	});
});

describe('replayDailyChallenge terminal precedence', () => {
	const lossDeck = () =>
		deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('10', 'clubs'),
			card('Q', 'spades'),
		);

	test('completes with bankroll-below-minimum before all rounds finish', () => {
		const commands: DailyChallengeCommandV1[] = [];
		for (let round = 0; round < 5; round += 1) {
			commands.push(startRound(round * 2, 200));
			commands.push(cmd(round * 2 + 1, 'stand'));
		}

		const replay = replayDailyChallenge(
			BLACKJACK_DAILY_V1_CONFIG,
			MASTER_SEED,
			commands,
			singleDeckSource(lossDeck()),
		);

		expect(replay.roundsCompleted).toBe(5);
		expect(replay.availableBankroll).toBe(0);
		expect(replay.status).toBe('completed');
		expect(replay.terminalReason).toBe('bankroll-below-minimum');
		expect(replay.eligible).toBe(true);
	});

	test('round-count completion wins over a sub-minimum bankroll', () => {
		const commands: DailyChallengeCommandV1[] = [];
		for (let round = 0; round < 10; round += 1) {
			commands.push(startRound(round * 2, 100));
			commands.push(cmd(round * 2 + 1, 'stand'));
		}

		const replay = replayDailyChallenge(
			BLACKJACK_DAILY_V1_CONFIG,
			MASTER_SEED,
			commands,
			singleDeckSource(lossDeck()),
		);

		expect(replay).toMatchObject({
			status: 'completed',
			terminalReason: 'completed',
			eligible: true,
			roundsCompleted: 10,
		});
		expect(replay.availableBankroll).toBe(0);
	});

	test('an accepted forfeit is ineligible and never reaches the adapter', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);

		const replay = replayDailyChallenge(
			BLACKJACK_DAILY_V1_CONFIG,
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
		expect(replay.activeRound?.adapterActions).toEqual([]);
		expect(replay.activeRoundPublic).toBeNull();
	});
});

describe('replayDailyChallenge error handling and determinism', () => {
	test('rejects a static wager below the configured minimum', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);

		expectDailyError('INVALID_WAGER', () =>
			replayDailyChallenge(
				BLACKJACK_DAILY_V1_CONFIG,
				MASTER_SEED,
				[startRound(0, 5)],
				singleDeckSource(deck),
			),
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
			replayDailyChallenge(
				BLACKJACK_DAILY_V1_CONFIG,
				MASTER_SEED,
				[startRound(0, 1500)],
				singleDeckSource(deck),
			),
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
			replayDailyChallenge(
				BLACKJACK_DAILY_V1_CONFIG,
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
			replayDailyChallenge(
				BLACKJACK_DAILY_V1_CONFIG,
				MASTER_SEED,
				[startRound(5, 100)],
				singleDeckSource(deck),
			),
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
			replayDailyChallenge(
				BLACKJACK_DAILY_V1_CONFIG,
				MASTER_SEED,
				[startRound(0, 100), startRound(1, 100)],
				singleDeckSource(deck),
			),
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
			replayDailyChallenge(
				BLACKJACK_DAILY_V1_CONFIG,
				MASTER_SEED,
				[cmd(0, 'stand')],
				singleDeckSource(deck),
			),
		);
	});

	test('is byte-identical for identical inputs', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);
		const commands: DailyChallengeCommandV1[] = [startRound(0, 100), cmd(1, 'stand')];

		const first = replayDailyChallenge(
			BLACKJACK_DAILY_V1_CONFIG,
			MASTER_SEED,
			commands,
			singleDeckSource(deck),
		);
		const second = replayDailyChallenge(
			BLACKJACK_DAILY_V1_CONFIG,
			MASTER_SEED,
			commands,
			singleDeckSource(deck),
		);

		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});
});

describe('replayDailyChallenge terminal guard errors', () => {
	const lossDeck = () =>
		deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('10', 'clubs'),
			card('Q', 'spades'),
		);

	test('rejects a start-round command after the challenge is terminal', () => {
		const commands: DailyChallengeCommandV1[] = [];
		for (let round = 0; round < 5; round += 1) {
			commands.push(startRound(round * 2, 200));
			commands.push(cmd(round * 2 + 1, 'stand'));
		}
		commands.push(startRound(10, 200));

		expectDailyError('ATTEMPT_COMPLETE', () =>
			replayDailyChallenge(
				BLACKJACK_DAILY_V1_CONFIG,
				MASTER_SEED,
				commands,
				singleDeckSource(lossDeck()),
			),
		);
	});

	test('rejects a blackjack action after the challenge is terminal', () => {
		const commands: DailyChallengeCommandV1[] = [];
		for (let round = 0; round < 5; round += 1) {
			commands.push(startRound(round * 2, 200));
			commands.push(cmd(round * 2 + 1, 'stand'));
		}
		commands.push(cmd(10, 'stand'));

		expectDailyError('ATTEMPT_COMPLETE', () =>
			replayDailyChallenge(
				BLACKJACK_DAILY_V1_CONFIG,
				MASTER_SEED,
				commands,
				singleDeckSource(lossDeck()),
			),
		);
	});

	test('rejects a start-round wager exceeding the available bankroll', () => {
		expectDailyError('INSUFFICIENT_CHALLENGE_BANKROLL', () =>
			replayDailyChallenge(
				BLACKJACK_DAILY_V1_CONFIG,
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
			replayDailyChallenge(
				BLACKJACK_DAILY_V1_CONFIG,
				MASTER_SEED,
				[startRound(0, 100), cmd(1, 'split')],
				singleDeckSource(deck),
			),
		);
	});
});
