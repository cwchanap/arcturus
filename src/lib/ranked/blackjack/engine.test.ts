import { describe, expect, test } from 'bun:test';
import type { Card, Rank, Suit } from '../../blackjack/types';
import { RankedServiceError, type RankedBlackjackAction } from '../protocol';
import { createInitialBlackjackState, replayRankedBlackjack } from './engine';
import type { RankedBlackjackConfigV1 } from './types';

const SUITS: readonly Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS: readonly Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function card(rank: Rank, suit: Suit): Card {
	return { rank, suit };
}

function config(initialWager: number): RankedBlackjackConfigV1 {
	return {
		gameType: 'blackjack',
		rulesetVersion: 'blackjack-ranked-v1',
		deckCount: 1,
		minimumWager: 10,
		maximumWager: 1000,
		maximumHands: 4,
		dealerHitsSoft17: false,
		blackjackProfitNumerator: 3,
		blackjackProfitDenominator: 2,
		normalWinProfitNumerator: 1,
		normalWinProfitDenominator: 1,
		initialWager,
	};
}

function action(sequence: number, actionName: RankedBlackjackAction) {
	return { sequence, action: actionName };
}

/**
 * Builds a complete, unique 52-card deck. `draws` is written in human deal
 * order, while the returned deck places those cards in reverse at the array
 * end because ranked Blackjack deals with `pop()` semantics.
 */
function deckWithDraws(...draws: readonly Card[]): Card[] {
	const canonicalDeck = SUITS.flatMap((suit) => RANKS.map((rank) => card(rank, suit)));
	const drawKeys = new Set(draws.map(({ rank, suit }) => `${rank}:${suit}`));
	expect(drawKeys.size).toBe(draws.length);
	const deck = [
		...canonicalDeck.filter(({ rank, suit }) => !drawKeys.has(`${rank}:${suit}`)),
		...[...draws].reverse(),
	];
	expect(deck).toHaveLength(52);
	return deck;
}

function deckForMixedSplit(): Card[] {
	return deckWithDraws(
		card('8', 'hearts'),
		card('8', 'diamonds'),
		card('6', 'hearts'),
		card('10', 'clubs'),
		card('10', 'hearts'),
		card('9', 'hearts'),
		card('10', 'diamonds'),
		card('2', 'clubs'),
	);
}

function deckForFourHands(): Card[] {
	return deckWithDraws(
		card('8', 'hearts'),
		card('8', 'diamonds'),
		card('10', 'clubs'),
		card('7', 'spades'),
		card('8', 'clubs'),
		card('8', 'spades'),
		card('2', 'hearts'),
		card('3', 'hearts'),
		card('4', 'hearts'),
		card('5', 'hearts'),
	);
}

function splitToFourHands() {
	return [action(0, 'split'), action(1, 'split'), action(2, 'stand'), action(3, 'split')];
}

function deckForPostSplitEleven(): Card[] {
	return deckWithDraws(
		card('5', 'hearts'),
		card('5', 'diamonds'),
		card('10', 'clubs'),
		card('7', 'spades'),
		card('6', 'clubs'),
		card('9', 'hearts'),
	);
}

describe('ranked Blackjack initial deal and naturals', () => {
	test('deals player-player-dealer-dealer from the array end without mutating the deck', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);
		const originalDeck = structuredClone(deck);

		const state = createInitialBlackjackState(config(100), deck);

		expect(state.phase).toBe('player-turn');
		expect(state.playerHands[0].cards).toEqual([card('10', 'hearts'), card('7', 'diamonds')]);
		expect(state.dealerHand.cards).toEqual([card('9', 'clubs'), card('8', 'spades')]);
		expect(state.deckCursor).toBe(4);
		expect(state.committedWager).toBe(100);
		expect(deck).toEqual(originalDeck);
	});

	test('settles two opening naturals as a push without accepting an action', () => {
		const replay = replayRankedBlackjack(
			config(100),
			deckWithDraws(
				card('A', 'hearts'),
				card('K', 'spades'),
				card('A', 'diamonds'),
				card('Q', 'clubs'),
			),
			[],
		);

		expect(replay.state.phase).toBe('complete');
		expect(replay.nextSequence).toBe(0);
		expect(replay.legalActions).toEqual([]);
		expect(replay.outcome).toEqual({
			result: 'push',
			hands: [{ handIndex: 0, result: 'push', wager: 100, payout: 100 }],
			committedWager: 100,
			payout: 100,
			gameNetDelta: 0,
		});
	});

	test('pays an opening player natural at 3:2 and floors odd-wager profit', () => {
		const replay = replayRankedBlackjack(
			config(11),
			deckWithDraws(
				card('A', 'hearts'),
				card('K', 'spades'),
				card('10', 'diamonds'),
				card('9', 'clubs'),
			),
			[],
		);

		expect(replay.outcome).toEqual({
			result: 'win',
			hands: [{ handIndex: 0, result: 'blackjack', wager: 11, payout: 27 }],
			committedWager: 11,
			payout: 27,
			gameNetDelta: 16,
		});
	});

	test('settles an opening dealer natural as a loss', () => {
		const replay = replayRankedBlackjack(
			config(25),
			deckWithDraws(
				card('10', 'hearts'),
				card('9', 'spades'),
				card('A', 'diamonds'),
				card('Q', 'clubs'),
			),
			[],
		);

		expect(replay.outcome).toMatchObject({
			result: 'loss',
			hands: [{ handIndex: 0, result: 'loss', wager: 25, payout: 0 }],
			committedWager: 25,
			payout: 0,
			gameNetDelta: -25,
		});
	});
});

describe('ranked Blackjack dealer transition and settlement', () => {
	test('dealer stands on soft 17', () => {
		const replay = replayRankedBlackjack(
			config(10),
			deckWithDraws(
				card('10', 'hearts'),
				card('8', 'diamonds'),
				card('A', 'clubs'),
				card('6', 'spades'),
				card('K', 'clubs'),
			),
			[action(0, 'stand')],
		);

		expect(replay.state.dealerHand.cards).toHaveLength(2);
		expect(replay.outcome?.hands[0]).toMatchObject({ result: 'win', payout: 20 });
	});

	test('skips dealer draws when every player hand is bust', () => {
		const replay = replayRankedBlackjack(
			config(10),
			deckWithDraws(
				card('10', 'hearts'),
				card('6', 'diamonds'),
				card('2', 'clubs'),
				card('3', 'spades'),
				card('K', 'clubs'),
				card('10', 'diamonds'),
			),
			[action(0, 'hit')],
		);

		expect(replay.state.phase).toBe('complete');
		expect(replay.state.dealerHand.cards).toHaveLength(2);
		expect(replay.state.deckCursor).toBe(5);
		expect(replay.outcome?.result).toBe('loss');
	});

	test('a final split-hand bust still runs the dealer when an earlier hand stood', () => {
		const replay = replayRankedBlackjack(config(100), deckForMixedSplit(), [
			action(0, 'split'),
			action(1, 'stand'),
			action(2, 'hit'),
		]);
		expect(replay.state.phase).toBe('complete');
		expect(replay.state.dealerHand.cards.length).toBeGreaterThan(2);
	});

	test.each([
		{
			name: 'normal win',
			player: [card('10', 'hearts'), card('10', 'diamonds')],
			dealer: [card('10', 'clubs'), card('8', 'spades')],
			result: 'win',
			payout: 40,
		},
		{
			name: 'normal loss',
			player: [card('10', 'hearts'), card('7', 'diamonds')],
			dealer: [card('10', 'clubs'), card('10', 'spades')],
			result: 'loss',
			payout: 0,
		},
		{
			name: 'normal push',
			player: [card('10', 'hearts'), card('8', 'diamonds')],
			dealer: [card('10', 'clubs'), card('8', 'spades')],
			result: 'push',
			payout: 20,
		},
	] as const)('settles a $name', ({ player, dealer, result, payout }) => {
		const replay = replayRankedBlackjack(config(20), deckWithDraws(...player, ...dealer), [
			action(0, 'stand'),
		]);

		expect(replay.outcome?.hands[0]).toMatchObject({ result, wager: 20, payout });
		expect(replay.outcome?.result).toBe(result);
	});

	test.each([
		{
			name: 'win',
			deck: () =>
				deckWithDraws(
					card('A', 'hearts'),
					card('A', 'diamonds'),
					card('10', 'clubs'),
					card('Q', 'spades'),
					card('K', 'hearts'),
					card('8', 'hearts'),
				),
			actions: [action(0, 'split'), action(1, 'stand'), action(2, 'stand')],
			hands: [
				{ handIndex: 0, result: 'blackjack', wager: 10, payout: 25 },
				{ handIndex: 1, result: 'loss', wager: 10, payout: 0 },
			],
			committedWager: 20,
			payout: 25,
			gameNetDelta: 5,
			result: 'win',
		},
		{
			name: 'loss',
			deck: () =>
				deckWithDraws(
					card('5', 'hearts'),
					card('5', 'diamonds'),
					card('10', 'clubs'),
					card('9', 'spades'),
					card('6', 'clubs'),
					card('10', 'hearts'),
					card('7', 'clubs'),
					card('5', 'clubs'),
				),
			actions: [action(0, 'split'), action(1, 'double-down'), action(2, 'hit'), action(3, 'stand')],
			hands: [
				{ handIndex: 0, result: 'loss', wager: 20, payout: 0 },
				{ handIndex: 1, result: 'win', wager: 10, payout: 20 },
			],
			committedWager: 30,
			payout: 20,
			gameNetDelta: -10,
			result: 'loss',
		},
		{
			name: 'push',
			deck: () =>
				deckWithDraws(
					card('9', 'hearts'),
					card('9', 'diamonds'),
					card('10', 'clubs'),
					card('8', 'spades'),
					card('K', 'hearts'),
					card('8', 'hearts'),
				),
			actions: [action(0, 'split'), action(1, 'stand'), action(2, 'stand')],
			hands: [
				{ handIndex: 0, result: 'win', wager: 10, payout: 20 },
				{ handIndex: 1, result: 'loss', wager: 10, payout: 0 },
			],
			committedWager: 20,
			payout: 20,
			gameNetDelta: 0,
			result: 'push',
		},
	] as const)(
		'classifies a mixed win/loss split session as an aggregate $name',
		({ deck, actions, name: _name, ...expectedOutcome }) => {
			const replay = replayRankedBlackjack(config(10), deck(), actions);

			expect(replay.outcome).toEqual(expectedOutcome);
		},
	);
});

describe('ranked Blackjack doubles and splits', () => {
	test('double-down commits one additional wager, deals one card, and completes the hand', () => {
		const replay = replayRankedBlackjack(
			config(10),
			deckWithDraws(
				card('5', 'hearts'),
				card('6', 'diamonds'),
				card('10', 'clubs'),
				card('7', 'spades'),
				card('10', 'hearts'),
			),
			[action(0, 'double-down')],
		);

		expect(replay.state.phase).toBe('complete');
		expect(replay.state.playerHands[0]).toEqual({
			cards: [card('5', 'hearts'), card('6', 'diamonds'), card('10', 'hearts')],
			wager: 20,
		});
		expect(replay.state.committedWager).toBe(20);
		expect(replay.nextSequence).toBe(1);
		expect(replay.outcome).toMatchObject({
			result: 'win',
			payout: 40,
			gameNetDelta: 20,
		});
	});

	test('split Blackjack keeps the 3:2 payout', () => {
		const replay = replayRankedBlackjack(
			config(10),
			deckWithDraws(
				card('A', 'hearts'),
				card('A', 'diamonds'),
				card('10', 'clubs'),
				card('7', 'spades'),
				card('K', 'hearts'),
				card('9', 'clubs'),
			),
			[action(0, 'split'), action(1, 'stand'), action(2, 'stand')],
		);

		expect(replay.outcome).toMatchObject({
			result: 'win',
			hands: [
				{ handIndex: 0, result: 'blackjack', wager: 10, payout: 25 },
				{ handIndex: 1, result: 'win', wager: 10, payout: 20 },
			],
			committedWager: 20,
			payout: 45,
			gameNetDelta: 25,
		});
	});

	test('reaches the canonical four-hand cap and does not offer a fifth split', () => {
		const fourHands = replayRankedBlackjack(config(10), deckForFourHands(), splitToFourHands());

		expect(fourHands.state.playerHands).toEqual([
			{ cards: [card('8', 'hearts'), card('2', 'hearts')], wager: 10 },
			{ cards: [card('8', 'diamonds'), card('4', 'hearts')], wager: 10 },
			{ cards: [card('8', 'clubs'), card('3', 'hearts')], wager: 10 },
			{ cards: [card('8', 'spades'), card('5', 'hearts')], wager: 10 },
		]);
		expect(fourHands.state.activeHandIndex).toBe(1);
		// A canonical single deck has only four cards of one rank. Reaching four
		// exact-rank split hands consumes all four, so an equal-rank active hand
		// capable of directly requesting a fifth split is unreachable.
		expect(fourHands.legalActions.some((entry) => entry.action === 'split')).toBe(false);
	});

	test('permits double-down on an eligible post-split hand', () => {
		const postSplit = replayRankedBlackjack(config(10), deckForPostSplitEleven(), [
			action(0, 'split'),
		]);
		expect(postSplit.legalActions).toContainEqual({ action: 'double-down', additionalWager: 10 });
	});

	test('reports additional wager only for double-down and split', () => {
		const replay = replayRankedBlackjack(
			config(15),
			deckWithDraws(
				card('5', 'hearts'),
				card('5', 'diamonds'),
				card('10', 'clubs'),
				card('7', 'spades'),
			),
			[],
		);

		expect(replay.legalActions).toEqual([
			{ action: 'hit', additionalWager: 0 },
			{ action: 'stand', additionalWager: 0 },
			{ action: 'double-down', additionalWager: 15 },
			{ action: 'split', additionalWager: 15 },
		]);
	});
});

describe('ranked Blackjack action-log rejection', () => {
	const activeDeck = () =>
		deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
			card('2', 'hearts'),
		);

	test('rejects a sequence gap with the expected sequence', () => {
		expect(() => replayRankedBlackjack(config(10), activeDeck(), [action(1, 'stand')])).toThrow(
			expect.objectContaining<Partial<RankedServiceError>>({
				code: 'SEQUENCE_MISMATCH',
				expectedSequence: 0,
			}),
		);
	});

	test('rejects a repeated sequence within the canonical log', () => {
		expect(() =>
			replayRankedBlackjack(config(10), activeDeck(), [action(0, 'hit'), action(0, 'stand')]),
		).toThrow(
			expect.objectContaining<Partial<RankedServiceError>>({
				code: 'SEQUENCE_MISMATCH',
				expectedSequence: 1,
			}),
		);
	});

	test('rejects a rule-illegal action', () => {
		expect(() => replayRankedBlackjack(config(10), activeDeck(), [action(0, 'split')])).toThrow(
			expect.objectContaining<Partial<RankedServiceError>>({
				code: 'INVALID_ACTION',
			}),
		);
	});

	test('rejects an action after opening settlement', () => {
		const naturalDeck = deckWithDraws(
			card('A', 'hearts'),
			card('K', 'spades'),
			card('10', 'diamonds'),
			card('9', 'clubs'),
		);

		expect(() => replayRankedBlackjack(config(10), naturalDeck, [action(0, 'stand')])).toThrow(
			expect.objectContaining<Partial<RankedServiceError>>({
				code: 'INVALID_ACTION',
			}),
		);
	});
});
