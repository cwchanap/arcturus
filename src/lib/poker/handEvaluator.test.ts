import { describe, expect, test } from 'bun:test';
import type { Card, Player } from './types';
import {
	determineShowdownWinners,
	estimateDrawingOuts,
	evaluatePostflopHand,
} from './handEvaluator';
import { createPlayer } from './player';

type CardSpec = [value: string, suit: Card['suit']];
type RankedCard = Card & { rank: number };

const CARD_VALUE_TO_RANK: Record<string, number> = {
	'2': 2,
	'3': 3,
	'4': 4,
	'5': 5,
	'6': 6,
	'7': 7,
	'8': 8,
	'9': 9,
	'10': 10,
	J: 11,
	Q: 12,
	K: 13,
	A: 14,
};

function makeCard([value, suit]: CardSpec): RankedCard {
	return { value, suit, rank: CARD_VALUE_TO_RANK[value] };
}

function buildPlayer(id: number, name: string, hole: CardSpec[]): Player {
	const player = createPlayer(id, name);
	return {
		...player,
		hand: hole.map(makeCard),
	};
}

function evaluateWinners(holeCards: CardSpec[][], community: CardSpec[]): Player[] {
	const players = holeCards.map((hole, idx) => buildPlayer(idx, `Player ${idx + 1}`, hole));
	const board = community.map(makeCard);
	return determineShowdownWinners(players, board);
}

describe('determineShowdownWinners()', () => {
	test('detects Royal Flush', () => {
		const winners = evaluateWinners(
			[
				[
					['A', 'hearts'],
					['K', 'hearts'],
				],
				[
					['Q', 'spades'],
					['Q', 'clubs'],
				],
			],
			[
				['J', 'hearts'],
				['10', 'hearts'],
				['Q', 'hearts'],
				['9', 'clubs'],
				['2', 'diamonds'],
			],
		);
		expect(winners).toHaveLength(1);
		expect(winners[0].name).toBe('Player 1');
	});

	test('Straight Flush beats Four of a Kind', () => {
		const winners = evaluateWinners(
			[
				[
					['A', 'hearts'],
					['K', 'hearts'],
				],
				[
					['Q', 'spades'],
					['Q', 'clubs'],
				],
			],
			[
				['9', 'hearts'],
				['10', 'hearts'],
				['J', 'hearts'],
				['Q', 'hearts'],
				['9', 'diamonds'],
			],
		);
		expect(winners).toHaveLength(1);
		expect(winners[0].name).toBe('Player 1');
	});

	test('Four of a Kind beats Full House', () => {
		const winners = evaluateWinners(
			[
				[
					['Q', 'hearts'],
					['2', 'clubs'],
				],
				[
					['J', 'spades'],
					['J', 'clubs'],
				],
			],
			[
				['Q', 'spades'],
				['Q', 'diamonds'],
				['Q', 'clubs'],
				['J', 'hearts'],
				['2', 'diamonds'],
			],
		);
		expect(winners).toHaveLength(1);
		expect(winners[0].name).toBe('Player 1');
	});

	test('Full House beats Flush', () => {
		const winners = evaluateWinners(
			[
				[
					['K', 'clubs'],
					['K', 'diamonds'],
				],
				[
					['A', 'spades'],
					['9', 'spades'],
				],
			],
			[
				['K', 'spades'],
				['9', 'hearts'],
				['9', 'clubs'],
				['2', 'spades'],
				['6', 'spades'],
			],
		);
		expect(winners).toHaveLength(1);
		expect(winners[0].name).toBe('Player 1');
	});

	test('Flush beats Straight', () => {
		// Make the board produce a 3-4-5-6-7 straight (so Player 2 has a straight)
		const winners = evaluateWinners(
			[
				[
					['A', 'spades'],
					['2', 'spades'],
				],
				[
					['10', 'hearts'],
					['9', 'clubs'],
				],
			],
			[
				['4', 'spades'],
				['6', 'spades'],
				['7', 'spades'], // changed from 8 to 7 so the board is 3-4-5-6-7
				['3', 'hearts'],
				['5', 'clubs'],
			],
		);
		expect(winners).toHaveLength(1);
		expect(winners[0].name).toBe('Player 1');
	});

	test('Straight beats Three of a Kind', () => {
		const winners = evaluateWinners(
			[
				[
					['9', 'hearts'],
					['8', 'clubs'],
				],
				[
					['A', 'spades'],
					['A', 'diamonds'],
				],
			],
			[
				['10', 'diamonds'],
				['7', 'spades'],
				['6', 'clubs'],
				['A', 'clubs'],
				['2', 'hearts'],
			],
		);
		expect(winners).toHaveLength(1);
		expect(winners[0].name).toBe('Player 1');
	});

	test('Three of a Kind beats Two Pair', () => {
		const winners = evaluateWinners(
			[
				[
					['10', 'clubs'],
					['10', 'diamonds'],
				],
				[
					['K', 'hearts'],
					['Q', 'clubs'],
				],
			],
			[
				['10', 'spades'],
				['K', 'spades'],
				['Q', 'hearts'],
				['2', 'clubs'],
				['7', 'diamonds'],
			],
		);
		expect(winners).toHaveLength(1);
		expect(winners[0].name).toBe('Player 1');
	});

	test('Two Pair beats One Pair', () => {
		const winners = evaluateWinners(
			[
				[
					['K', 'hearts'],
					['Q', 'hearts'],
				],
				[
					['A', 'clubs'],
					['J', 'diamonds'],
				],
			],
			[
				['K', 'clubs'],
				['Q', 'diamonds'],
				['9', 'clubs'],
				['J', 'spades'],
				['2', 'hearts'],
			],
		);
		expect(winners).toHaveLength(1);
		expect(winners[0].name).toBe('Player 1');
	});

	test('One Pair beats High Card', () => {
		const winners = evaluateWinners(
			[
				[
					['9', 'hearts'],
					['K', 'clubs'],
				],
				[
					['Q', 'spades'],
					['J', 'diamonds'],
				],
			],
			[
				['9', 'clubs'],
				['7', 'diamonds'],
				['6', 'hearts'],
				['5', 'clubs'],
				['2', 'spades'],
			],
		);
		expect(winners).toHaveLength(1);
		expect(winners[0].name).toBe('Player 1');
	});

	test('Ace-to-Five straight (wheel) uses ace as low card', () => {
		const winners = evaluateWinners(
			[
				[
					['A', 'hearts'],
					['4', 'clubs'],
				],
				[
					['K', 'spades'],
					['K', 'diamonds'],
				],
			],
			[
				['5', 'clubs'],
				['3', 'diamonds'],
				['2', 'spades'],
				['9', 'hearts'],
				['J', 'clubs'],
			],
		);
		expect(winners).toHaveLength(1);
		expect(winners[0].name).toBe('Player 1');
	});

	test('Split pot when hands are identical', () => {
		const winners = evaluateWinners(
			[
				[
					['A', 'hearts'],
					['K', 'clubs'],
				],
				[
					['A', 'diamonds'],
					['K', 'spades'],
				],
			],
			[
				['Q', 'hearts'],
				['J', 'clubs'],
				['10', 'diamonds'],
				['2', 'spades'],
				['3', 'clubs'],
			],
		);
		expect(winners).toHaveLength(2);
		expect(winners.map((w) => w.name)).toEqual(['Player 1', 'Player 2']);
	});

	test('Kicker breaks tie for single pair', () => {
		const winners = evaluateWinners(
			[
				[
					['A', 'hearts'],
					['Q', 'clubs'],
				],
				[
					['A', 'diamonds'],
					['J', 'spades'],
				],
			],
			[
				['7', 'clubs'],
				['7', 'diamonds'],
				['5', 'spades'],
				['2', 'hearts'],
				['3', 'clubs'],
			],
		);
		expect(winners).toHaveLength(1);
		expect(winners[0].name).toBe('Player 1');
	});

	test('Kicker breaks tie for two pair', () => {
		const winners = evaluateWinners(
			[
				[
					['A', 'spades'],
					['7', 'clubs'],
				],
				[
					['J', 'hearts'],
					['10', 'clubs'],
				],
			],
			[
				['K', 'hearts'],
				['K', 'diamonds'],
				['Q', 'spades'],
				['Q', 'diamonds'],
				['2', 'clubs'],
			],
		);
		expect(winners).toHaveLength(1);
		expect(winners[0].name).toBe('Player 1');
	});

	test('Kicker breaks tie for three of a kind', () => {
		const winners = evaluateWinners(
			[
				[
					['A', 'clubs'],
					['2', 'diamonds'],
				],
				[
					['K', 'hearts'],
					['J', 'clubs'],
				],
			],
			[
				['Q', 'spades'],
				['Q', 'hearts'],
				['Q', 'diamonds'],
				['7', 'clubs'],
				['5', 'hearts'],
			],
		);
		expect(winners).toHaveLength(1);
		expect(winners[0].name).toBe('Player 1');
	});
});

describe('evaluatePostflopHand()', () => {
	function hole(value: string, suit: Card['suit']): Card {
		return { value, suit, rank: CARD_VALUE_TO_RANK[value] };
	}

	test('detects a wheel straight (A-2-3-4-5) as a straight', () => {
		// Player holds A-2, board brings 3-4-5 → wheel straight.
		const hand = [hole('A', 'spades'), hole('2', 'hearts')];
		const community = [hole('3', 'clubs'), hole('4', 'diamonds'), hole('5', 'spades')];

		const wheelStrength = evaluatePostflopHand(hand, community);

		// Compare against a non-straight high-card hand of the same cards minus the wheel.
		const highCardStrength = evaluatePostflopHand(
			[hole('A', 'spades'), hole('K', 'hearts')],
			[hole('3', 'clubs'), hole('4', 'diamonds'), hole('7', 'spades')],
		);

		// A straight (0.8) must beat ace-high (0.35).
		expect(wheelStrength).toBeGreaterThanOrEqual(0.8);
		expect(wheelStrength).toBeGreaterThan(highCardStrength);
	});

	test('detects a regular straight postflop', () => {
		const hand = [hole('9', 'spades'), hole('10', 'hearts')];
		const community = [hole('J', 'clubs'), hole('Q', 'diamonds'), hole('K', 'spades')];

		const strength = evaluatePostflopHand(hand, community);
		expect(strength).toBeGreaterThanOrEqual(0.8);
	});

	test('does not over-report straight flush when flush and straight use different cards', () => {
		// Player holds 2h-9h. Board: 3h-4h-5h-6c-7c.
		// Hearts flush ranks: 2,3,4,5,9 → no straight in the flush suit.
		// Overall ranks: 2,3,4,5,6,7,9 → 3-4-5-6-7 straight (non-flush).
		// hasFlush && hasStraight but NOT a straight flush → should report
		// 0.85 (flush), not 0.99 (straight flush).
		const hand = [hole('2', 'hearts'), hole('9', 'hearts')];
		const community = [
			hole('3', 'hearts'),
			hole('4', 'hearts'),
			hole('5', 'hearts'),
			hole('6', 'clubs'),
			hole('7', 'clubs'),
		];

		const strength = evaluatePostflopHand(hand, community);
		expect(strength).toBe(0.85);
	});

	test('still detects a true straight flush', () => {
		// Player holds 6h-7h. Board: 8h-9h-10h-2c-3c.
		// Hearts flush ranks: 6,7,8,9,10 → straight flush.
		const hand = [hole('6', 'hearts'), hole('7', 'hearts')];
		const community = [
			hole('8', 'hearts'),
			hole('9', 'hearts'),
			hole('10', 'hearts'),
			hole('2', 'clubs'),
			hole('3', 'clubs'),
		];

		const strength = evaluatePostflopHand(hand, community);
		expect(strength).toBe(0.99);
	});
});

describe('estimateDrawingOuts()', () => {
	function hole(value: string, suit: Card['suit']): Card {
		return { value, suit, rank: CARD_VALUE_TO_RANK[value] };
	}

	test('counts pair-to-trips outs for a single pair with no trips', () => {
		// Player has a pair of 9s, no trips on board.
		const hand = [hole('9', 'spades'), hole('9', 'hearts')];
		const community = [hole('K', 'clubs'), hole('4', 'diamonds'), hole('2', 'spades')];

		const outs = estimateDrawingOuts(hand, community);
		// Should include the 2 trip outs for the pair.
		expect(outs).toBeGreaterThanOrEqual(2);
	});

	test('does not add pair outs when trips are already present', () => {
		// Board has trips (KKK); player holds a pair of 9s.
		// With trips already made, the pair-to-trips outs should not double-count.
		const hand = [hole('9', 'spades'), hole('9', 'hearts')];
		const community = [hole('K', 'clubs'), hole('K', 'diamonds'), hole('K', 'spades')];

		const tripsOuts = estimateDrawingOuts(hand, community);

		// Compare against a single-pair no-trips scenario.
		const pairOuts = estimateDrawingOuts(
			[hole('9', 'spades'), hole('9', 'hearts')],
			[hole('K', 'clubs'), hole('4', 'diamonds'), hole('2', 'spades')],
		);

		// Trips scenario must not report pair-draw outs; lone-pair should.
		expect(tripsOuts).toBeLessThan(pairOuts);
	});

	test('does not add straight-draw outs when a straight is already made', () => {
		// Player + board form a made straight (6-7-8-9-10). The open-ended
		// draw check would otherwise see 4 consecutive values and add 8 outs
		// even though the straight is complete.
		const hand = [hole('7', 'hearts'), hole('8', 'spades')];
		const community = [hole('6', 'clubs'), hole('9', 'diamonds'), hole('10', 'spades')];

		const outs = estimateDrawingOuts(hand, community);

		// No flush draw, no pair, and the straight is already made, so the
		// only possible outs are pair-to-trips (none here). Must be 0.
		expect(outs).toBe(0);
	});
});
