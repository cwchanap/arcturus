import { describe, expect, test } from 'bun:test';
import type { Card, Player } from './types';
import { determineShowdownWinners } from './handEvaluator';
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
				['K', 'hearts'],
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
				['8', 'spades'],
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
					['9', 'hearts'],
					['9', 'spades'],
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
					['A', 'hearts'],
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
