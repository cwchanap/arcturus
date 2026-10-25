import { describe, expect, test } from 'bun:test';
import { createPlayer } from './player';
import {
	SNG_START_STACK,
	SNG_BLINDS,
	SNG_HANDS_PER_LEVEL,
	levelFor,
	nextFundedSeats,
	humanPlace,
	seatsInHand,
} from './sitAndGo';

function sixSeats(chips: number[]): ReturnType<typeof createPlayer>[] {
	return chips.map((c, id) => createPlayer(id, `Seat ${id}`, c));
}

describe('SNG setup constants', () => {
	test('fixed setup values', () => {
		expect(SNG_START_STACK).toBe(500);
		expect(SNG_HANDS_PER_LEVEL).toBe(5);
		expect(SNG_BLINDS).toEqual([
			{ small: 5, big: 10 },
			{ small: 10, big: 20 },
			{ small: 20, big: 40 },
			{ small: 40, big: 80 },
			{ small: 80, big: 160 },
		]);
	});
});

describe('levelFor()', () => {
	test('derives level and blinds from 1-based handNumber for hands 1/5/6/10/11/16/21', () => {
		const cases: Array<[number, number, { small: number; big: number }]> = [
			[1, 0, { small: 5, big: 10 }],
			[5, 0, { small: 5, big: 10 }],
			[6, 1, { small: 10, big: 20 }],
			[10, 1, { small: 10, big: 20 }],
			[11, 2, { small: 20, big: 40 }],
			[16, 3, { small: 40, big: 80 }],
			[21, 4, { small: 80, big: 160 }],
		];
		for (const [handNumber, level, blinds] of cases) {
			expect(levelFor(handNumber)).toBe(level);
			expect(SNG_BLINDS[levelFor(handNumber)]).toEqual(
				blinds as unknown as (typeof SNG_BLINDS)[number],
			);
		}
	});

	test('caps at the last level forever', () => {
		expect(levelFor(25)).toBe(4);
		expect(levelFor(26)).toBe(4);
		expect(levelFor(100)).toBe(4);
		expect(SNG_BLINDS[levelFor(100)]).toEqual({ small: 80, big: 160 });
	});

	test('clamps the pre-deal hand number 0 to level 0', () => {
		expect(levelFor(0)).toBe(0);
		expect(SNG_BLINDS[levelFor(0)]).toEqual({ small: 5, big: 10 });
	});
});

describe('seatsInHand()', () => {
	test('returns the funded seats in table order before any hand', () => {
		const players = sixSeats([500, 0, 500, 0, 0, 500]);
		expect(seatsInHand(players, new Map())).toEqual([0, 2, 5]);
	});

	test('a mid-hand all-in stays in the order via its hand-start stack', () => {
		const players = sixSeats([0, 200, 0, 350, 0, 0]);
		// Seats 1 and 3 were dealt in; seat 3 went all-in to zero.
		const handStartStacks = new Map([
			[1, 500],
			[3, 350],
		]);
		expect(seatsInHand(players, handStartStacks)).toEqual([1, 3]);
	});

	test('seats that were never dealt in stay out of the order', () => {
		const players = sixSeats([500, 0, 500, 500, 0, 500]);
		const handStartStacks = new Map([
			[0, 500],
			[2, 500],
			[3, 500],
			[5, 500],
		]);
		expect(seatsInHand(players, handStartStacks)).toEqual([0, 2, 3, 5]);
	});
});

describe('nextFundedSeats()', () => {
	test('full table rotates button, SB, BB clockwise', () => {
		const players = sixSeats([500, 500, 500, 500, 500, 500]);
		expect(nextFundedSeats(players, 0)).toEqual({
			buttonIndex: 1,
			smallBlindIndex: 2,
			bigBlindIndex: 3,
		});
		expect(nextFundedSeats(players, 5)).toEqual({
			buttonIndex: 0,
			smallBlindIndex: 1,
			bigBlindIndex: 2,
		});
	});

	test('skips busted seats and wraps around', () => {
		const players = sixSeats([500, 0, 500, 0, 500, 0]);
		// Funded seats: 0, 2, 4
		expect(nextFundedSeats(players, 4)).toEqual({
			buttonIndex: 0,
			smallBlindIndex: 2,
			bigBlindIndex: 4,
		});
		expect(nextFundedSeats(players, 0)).toEqual({
			buttonIndex: 2,
			smallBlindIndex: 4,
			bigBlindIndex: 0,
		});
	});

	test('skips gaps when the dealer seat just busted', () => {
		const players = sixSeats([500, 0, 500, 500, 500, 0]);
		// Funded seats: 0, 2, 3, 4; dealer at seat 1 busted
		expect(nextFundedSeats(players, 1)).toEqual({
			buttonIndex: 2,
			smallBlindIndex: 3,
			bigBlindIndex: 4,
		});
	});

	test('heads-up: button is small blind and roles alternate', () => {
		const players = sixSeats([0, 0, 500, 0, 500, 0]);
		// Funded seats: 2, 4
		expect(nextFundedSeats(players, 2)).toEqual({
			buttonIndex: 4,
			smallBlindIndex: 4,
			bigBlindIndex: 2,
		});
		expect(nextFundedSeats(players, 4)).toEqual({
			buttonIndex: 2,
			smallBlindIndex: 2,
			bigBlindIndex: 4,
		});
	});
});

describe('humanPlace()', () => {
	test('last to bust with no simultaneous busts', () => {
		expect(humanPlace(5, 500, [])).toBe(6);
	});

	test('simultaneous busts with larger starting stacks push human down', () => {
		expect(humanPlace(4, 500, [900])).toBe(6);
		expect(humanPlace(3, 500, [900, 700])).toBe(6);
	});

	test('equal starting stacks tie their placing', () => {
		expect(humanPlace(4, 500, [500])).toBe(5);
		expect(humanPlace(3, 500, [900, 500, 300])).toBe(5);
	});
});
