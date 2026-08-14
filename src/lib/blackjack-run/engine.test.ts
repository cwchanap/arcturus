import { describe, expect, test } from 'bun:test';
import type { Card, Rank, Suit } from '../blackjack/types';
import {
	projectBlackjackRoundReplay,
	replayBlackjackRound,
	replayBlackjackRoundWithDeck,
	shuffleDeck,
} from './engine';
import { BlackjackRunError, type BlackjackAction } from './protocol';

const SUITS: readonly Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS: readonly Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function card(rank: Rank, suit: Suit): Card {
	return { rank, suit };
}

/**
 * Builds a complete, unique 52-card deck. `draws` is written in human deal
 * order, while the returned deck places those cards in reverse at the array
 * end because Blackjack deals with `pop()` semantics.
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

function splitToFourHands(): BlackjackAction[] {
	return ['split', 'split', 'stand', 'split'];
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

describe('Blackjack initial deal and naturals', () => {
	test('deals player-player-dealer-dealer from the array end without mutating the deck', () => {
		const deck = deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);
		const originalDeck = structuredClone(deck);

		const replay = replayBlackjackRoundWithDeck(100, deck, []);

		expect(replay.state.phase).toBe('player-turn');
		expect(replay.state.playerHands[0].cards).toEqual([
			card('10', 'hearts'),
			card('7', 'diamonds'),
		]);
		expect(replay.state.dealerHand.cards).toEqual([card('9', 'clubs'), card('8', 'spades')]);
		expect(replay.state.deckCursor).toBe(4);
		expect(replay.state.committedWager).toBe(100);
		expect(deck).toEqual(originalDeck);
	});

	test('derives an identical replay from the same seed without mutating it', () => {
		const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 7);
		const originalSeed = seed.slice();

		const first = replayBlackjackRound({ seed, initialWager: 50, actions: [] });
		const second = replayBlackjackRound({ seed: seed.slice(), initialWager: 50, actions: [] });

		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(seed).toEqual(originalSeed);
	});

	test('seed-based replay deals exactly the cards shuffleDeck exposes from the array end', () => {
		const seed = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
		const deck = shuffleDeck(seed);

		const replay = replayBlackjackRound({ seed, initialWager: 25, actions: ['stand'] });

		expect(replay.state.playerHands[0].cards).toEqual([deck[51], deck[50]]);
		// The dealer may draw after the stand; the opening two cards must still
		// be the next two cards from the array end.
		expect(replay.state.dealerHand.cards.slice(0, 2)).toEqual([deck[49], deck[48]]);
		expect(replay.state.deckCursor).toBe(
			replay.state.playerHands[0].cards.length + replay.state.dealerHand.cards.length,
		);
	});

	test('settles two opening naturals as a push without accepting an action', () => {
		const replay = replayBlackjackRoundWithDeck(
			100,
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
		const replay = replayBlackjackRoundWithDeck(
			11,
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
		const replay = replayBlackjackRoundWithDeck(
			25,
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

describe('Blackjack dealer transition and settlement', () => {
	test('dealer stands on soft 17', () => {
		const replay = replayBlackjackRoundWithDeck(
			10,
			deckWithDraws(
				card('10', 'hearts'),
				card('8', 'diamonds'),
				card('A', 'clubs'),
				card('6', 'spades'),
				card('K', 'clubs'),
			),
			['stand'],
		);

		expect(replay.state.dealerHand.cards).toHaveLength(2);
		expect(replay.outcome?.hands[0]).toMatchObject({ result: 'win', payout: 20 });
	});

	test('skips dealer draws when every player hand is bust', () => {
		const replay = replayBlackjackRoundWithDeck(
			10,
			deckWithDraws(
				card('10', 'hearts'),
				card('6', 'diamonds'),
				card('2', 'clubs'),
				card('3', 'spades'),
				card('K', 'clubs'),
				card('10', 'diamonds'),
			),
			['hit'],
		);

		expect(replay.state.phase).toBe('complete');
		expect(replay.state.dealerHand.cards).toHaveLength(2);
		expect(replay.state.deckCursor).toBe(5);
		expect(replay.outcome?.result).toBe('loss');
	});

	test('a final split-hand bust still runs the dealer when an earlier hand stood', () => {
		const replay = replayBlackjackRoundWithDeck(100, deckForMixedSplit(), [
			'split',
			'stand',
			'hit',
		]);
		expect(replay.state.phase).toBe('complete');
		// Dealer drew exactly one card (the 2♣) to a hard 16 then stood at 18.
		// Pinning the exact cards catches a regression where the dealer
		// threshold changes (e.g. hits on 17+) — such a bug would still
		// satisfy a loose `length > 2` assertion but would draw extra cards.
		expect(replay.state.dealerHand.cards).toEqual([
			card('6', 'hearts'),
			card('10', 'clubs'),
			card('2', 'clubs'),
		]);
		expect(replay.state.playerHands).toHaveLength(2);
		expect(replay.state.playerHands[0].cards).toEqual([card('8', 'hearts'), card('10', 'hearts')]);
		expect(replay.state.playerHands[1].cards).toEqual([
			card('8', 'diamonds'),
			card('9', 'hearts'),
			card('10', 'diamonds'),
		]);
		// Hand 0 pushed (18 vs 18); hand 1 busted (27). Net -100.
		expect(replay.outcome?.hands).toEqual([
			{ handIndex: 0, result: 'push', wager: 100, payout: 100 },
			{ handIndex: 1, result: 'loss', wager: 100, payout: 0 },
		]);
		expect(replay.outcome?.result).toBe('loss');
		expect(replay.outcome?.committedWager).toBe(200);
		expect(replay.outcome?.payout).toBe(100);
		expect(replay.outcome?.gameNetDelta).toBe(-100);
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
		const replay = replayBlackjackRoundWithDeck(20, deckWithDraws(...player, ...dealer), ['stand']);

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
			actions: ['split', 'stand', 'stand'],
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
			actions: ['split', 'double-down', 'hit', 'stand'],
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
			actions: ['split', 'stand', 'stand'],
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
			const replay = replayBlackjackRoundWithDeck(10, deck(), actions);

			expect(replay.outcome).toEqual(expectedOutcome);
		},
	);
});

describe('Blackjack doubles and splits', () => {
	test('double-down commits one additional wager, deals one card, and completes the hand', () => {
		const replay = replayBlackjackRoundWithDeck(
			10,
			deckWithDraws(
				card('5', 'hearts'),
				card('6', 'diamonds'),
				card('10', 'clubs'),
				card('7', 'spades'),
				card('10', 'hearts'),
			),
			['double-down'],
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
		const replay = replayBlackjackRoundWithDeck(
			10,
			deckWithDraws(
				card('A', 'hearts'),
				card('A', 'diamonds'),
				card('10', 'clubs'),
				card('7', 'spades'),
				card('K', 'hearts'),
				card('9', 'clubs'),
			),
			['split', 'stand', 'stand'],
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
		const fourHands = replayBlackjackRoundWithDeck(10, deckForFourHands(), splitToFourHands());

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
		const postSplit = replayBlackjackRoundWithDeck(10, deckForPostSplitEleven(), ['split']);
		expect(postSplit.legalActions).toContainEqual({ action: 'double-down', additionalWager: 10 });
	});

	test('reports additional wager only for double-down and split', () => {
		const replay = replayBlackjackRoundWithDeck(
			15,
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

describe('Blackjack action rejection', () => {
	const activeDeck = () =>
		deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
			card('2', 'hearts'),
		);

	test('rejects a rule-illegal action', () => {
		expect(() => replayBlackjackRoundWithDeck(10, activeDeck(), ['split'])).toThrow(
			expect.objectContaining<Partial<BlackjackRunError>>({
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

		expect(() => replayBlackjackRoundWithDeck(10, naturalDeck, ['stand'])).toThrow(
			expect.objectContaining<Partial<BlackjackRunError>>({
				code: 'INVALID_ACTION',
			}),
		);
	});
});

describe('projectBlackjackRoundReplay', () => {
	const doubleSplitCapableDeck = () =>
		deckWithDraws(
			card('5', 'hearts'),
			card('5', 'diamonds'),
			card('10', 'clubs'),
			card('7', 'spades'),
		);
	const incompleteDeck = () =>
		deckWithDraws(
			card('10', 'hearts'),
			card('7', 'diamonds'),
			card('9', 'clubs'),
			card('8', 'spades'),
		);

	test('filters split and double-down using the supplied available balance', () => {
		const replay = replayBlackjackRoundWithDeck(100, doubleSplitCapableDeck(), []);

		const projected = projectBlackjackRoundReplay(replay, 9);

		expect(projected.availableActions).toEqual(['hit', 'stand']);
		expect(projected.nextSequence).toBe(replay.nextSequence);
	});

	test('keeps funded split and double-down actions when the balance covers them', () => {
		const replay = replayBlackjackRoundWithDeck(100, doubleSplitCapableDeck(), []);

		const projected = projectBlackjackRoundReplay(replay, 100);

		expect(projected.availableActions).toEqual(['hit', 'stand', 'double-down', 'split']);
	});

	test('force-terminal reveals the dealer and clears actions', () => {
		const replay = replayBlackjackRoundWithDeck(100, incompleteDeck(), []);

		const projected = projectBlackjackRoundReplay(replay, 1000, true);

		expect(projected.phase).toBe('complete');
		expect(projected.dealer.cards).toHaveLength(replay.state.dealerHand.cards.length);
		expect(projected.availableActions).toEqual([]);
	});

	test('projects hand values and strips the deck cursor', () => {
		const replay = replayBlackjackRoundWithDeck(
			100,
			deckWithDraws(
				card('A', 'hearts'),
				card('K', 'spades'),
				card('10', 'diamonds'),
				card('9', 'clubs'),
			),
			[],
		);

		const projected = projectBlackjackRoundReplay(replay, 1000);

		expect(projected.playerHands[0]).toEqual({
			cards: [card('A', 'hearts'), card('K', 'spades')],
			wager: 100,
			value: { value: 21, isSoft: true, isBust: false },
		});
		// The opening natural settles immediately, so the terminal projection
		// reveals both dealer cards.
		expect(projected.dealer).toEqual({
			cards: [card('10', 'diamonds'), card('9', 'clubs')],
			value: { value: 19, isSoft: false, isBust: false },
		});
		expect(projected.outcome).not.toBeNull();
	});
});
