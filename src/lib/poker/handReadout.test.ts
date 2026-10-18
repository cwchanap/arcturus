import { describe, expect, test } from 'bun:test';
import { countDrawingOuts, readHand } from './handReadout';
import type { Card } from './types';

function c(code: string): Card {
	const value = code.slice(0, -1);
	const suit = ({ h: 'hearts', d: 'diamonds', c: 'clubs', s: 'spades' } as const)[
		code.slice(-1) as 'h' | 'd' | 'c' | 's'
	];
	const rank = { J: 11, Q: 12, K: 13, A: 14 }[value] ?? Number(value);
	return { value, suit, rank };
}

const codes = (cards: Card[]) => cards.map((card) => `${card.value}${card.suit[0]}`).sort();

describe('readHand', () => {
	test('returns null before two cards are known', () => {
		expect(readHand([], [])).toBeNull();
		expect(readHand([c('Ah')], [])).toBeNull();
	});

	test('reads a preflop pocket pair and a preflop high card', () => {
		expect(readHand([c('9h'), c('9s')], [])).toMatchObject({ key: 'PAIR', usesHoleCards: true });
		const high = readHand([c('3c'), c('Qh')], []);
		expect(high?.key).toBe('HIGH_CARD');
		expect(codes(high!.coreCards)).toEqual(['Qh']);
	});

	test('core cards of a pair exclude the kickers', () => {
		const readout = readHand([c('3c'), c('Qh')], [c('4h'), c('Qs'), c('10d'), c('8c'), c('Js')]);
		expect(readout?.key).toBe('PAIR');
		expect(codes(readout!.coreCards)).toEqual(['Qh', 'Qs']);
		expect(readout?.usesHoleCards).toBe(true);
	});

	test('the best five include the decisive kicker the core cards omit', () => {
		// Board K K 9 8 5: A-2 beats Q-J on the ace kicker. The ace is not a
		// core card of the pair, but it is part of the winning five.
		const readout = readHand([c('Ah'), c('2c')], [c('Kh'), c('Ks'), c('9d'), c('8c'), c('5s')]);
		expect(readout?.key).toBe('PAIR');
		expect(codes(readout!.coreCards)).toEqual(['Kh', 'Ks']);
		expect(codes(readout!.bestCards)).toEqual(['8c', '9d', 'Ah', 'Kh', 'Ks']);
	});

	test('before the board the best cards are the known cards themselves', () => {
		expect(codes(readHand([c('Ah'), c('Ks')], [])!.bestCards)).toEqual(['Ah', 'Ks']);
	});

	test('finds a straight using one hole card', () => {
		const readout = readHand([c('2d'), c('9h')], [c('4h'), c('Qs'), c('10d'), c('8c'), c('Js')]);
		expect(readout?.key).toBe('STRAIGHT');
		expect(codes(readout!.coreCards)).toEqual(['10d', '8c', '9h', 'Js', 'Qs']);
	});

	test('flags a hand that the board plays entirely', () => {
		const readout = readHand([c('2d'), c('3c')], [c('Kh'), c('Ks'), c('9d'), c('8c'), c('5s')]);
		expect(readout?.key).toBe('PAIR');
		expect(readout?.usesHoleCards).toBe(false);
		expect(readout?.boardPlays).toBe(true);
	});

	test('a hole card that plays only as a kicker means the board does not play', () => {
		const readout = readHand([c('Ad'), c('2c')], [c('Kh'), c('Ks'), c('9d'), c('8c'), c('5s')]);
		expect(readout?.key).toBe('PAIR');
		expect(readout?.usesHoleCards).toBe(false);
		expect(readout?.boardPlays).toBe(false);
	});

	test('the board can only play on the river', () => {
		const flop = readHand([c('2d'), c('3c')], [c('Kh'), c('Ks'), c('9d')]);
		expect(flop?.usesHoleCards).toBe(false);
		expect(flop?.boardPlays).toBe(false);
	});

	// Classification cases migrated from the removed test-only
	// `evaluateHandKey` in PokerUIRenderer — `readHand` is the production
	// readout these labels now come from.
	test('classifies pairs, two pair, trips, and quads', () => {
		expect(readHand([c('Ah'), c('As')], [])?.key).toBe('PAIR');
		expect(readHand([c('Ah'), c('As')], [c('Kh'), c('Kd'), c('9c'), c('2c')])?.key).toBe(
			'TWO_PAIR',
		);
		expect(readHand([c('Qh'), c('Qs')], [c('Qd'), c('9c'), c('2h')])?.key).toBe('THREE_OF_A_KIND');
		expect(readHand([c('Jh'), c('Js')], [c('Jd'), c('Jc'), c('2h')])?.key).toBe('FOUR_OF_A_KIND');
	});

	test('classifies full house', () => {
		expect(readHand([c('Ah'), c('As')], [c('Ad'), c('Kc'), c('Kh')])?.key).toBe('FULL_HOUSE');
	});

	test('classifies straights including the wheel', () => {
		expect(readHand([c('6h'), c('7h')], [c('8s'), c('9s'), c('10s')])?.key).toBe('STRAIGHT');
		expect(readHand([c('Ah'), c('2s')], [c('3c'), c('4d'), c('5h')])?.key).toBe('STRAIGHT');
	});

	test('classifies flush, straight flush, royal flush, and high card', () => {
		expect(readHand([c('Ah'), c('Kh')], [c('Qh'), c('Jh'), c('10h')])?.key).toBe('ROYAL_FLUSH');
		expect(readHand([c('5d'), c('6d')], [c('7d'), c('8d'), c('9d')])?.key).toBe('STRAIGHT_FLUSH');
		expect(readHand([c('Ac'), c('Kc')], [c('Qc'), c('9c'), c('2c')])?.key).toBe('FLUSH');
		expect(readHand([c('Ah'), c('Ks')], [c('Qd'), c('9c'), c('2h')])?.key).toBe('HIGH_CARD');
	});

	test('distinguishes a royal flush from a straight flush', () => {
		expect(readHand([c('Ah'), c('Kh')], [c('Qh'), c('Jh'), c('10h'), c('2c'), c('3d')])?.key).toBe(
			'ROYAL_FLUSH',
		);
		expect(readHand([c('9h'), c('Kh')], [c('Qh'), c('Jh'), c('10h'), c('2c'), c('3d')])?.key).toBe(
			'STRAIGHT_FLUSH',
		);
	});
});

describe('countDrawingOuts', () => {
	test('a broadway gutshot has 4 outs, not 8', () => {
		// A-K on Q-J-7-2: only a ten completes the straight — 4 distinct cards.
		expect(countDrawingOuts([c('Ah'), c('Kd')], [c('Qc'), c('Js'), c('2h'), c('7d')])).toBe(4);
	});

	test('an ordinary gutshot counts', () => {
		// 5-6 on 8-9-2: only a seven completes 5-6-7-8-9.
		expect(countDrawingOuts([c('5h'), c('6h')], [c('8s'), c('9c'), c('2d')])).toBe(4);
	});

	test('an open-ended draw counts both ends', () => {
		// 8-9 on T-J-2: a seven or a queen completes it — 8 distinct cards.
		expect(countDrawingOuts([c('8h'), c('9h')], [c('10c'), c('Js'), c('2d')])).toBe(8);
	});

	test('a wheel draw counts the four fives', () => {
		// A-2 on 3-4-K: only a five completes A-2-3-4-5.
		expect(countDrawingOuts([c('As'), c('2d')], [c('4c'), c('3h'), c('Ks')])).toBe(4);
	});

	test('overlapping draws count each finishing card once', () => {
		// 8-9 of hearts on J-Q-2: 9 hearts finish the flush, 4 tens finish the
		// straight, and the ten of hearts does both — 12, not 17.
		expect(countDrawingOuts([c('8h'), c('9h')], [c('Jh'), c('Qh'), c('2c')])).toBe(12);
	});

	test('a lone pair draws to trips with 2 outs', () => {
		expect(countDrawingOuts([c('Ac'), c('Ad')], [c('Ks'), c('9h'), c('4d')])).toBe(2);
	});

	test('a made hand does not manufacture draws behind itself', () => {
		// The straight is already made; no straight outs, and no pair for trips.
		expect(countDrawingOuts([c('8h'), c('9d')], [c('10c'), c('Js'), c('Qd'), c('2h')])).toBe(0);
	});

	test('a flush draw counts its 9 suit cards', () => {
		expect(countDrawingOuts([c('Ah'), c('7h')], [c('2h'), c('9h'), c('Kc')])).toBe(9);
	});

	test('a made flush counts only the straight-flush cards', () => {
		// 8h-9h on 10h-Jh-2h: only 7h and Qh beat the flush; other sevens and queens make a lower straight.
		expect(countDrawingOuts([c('8h'), c('9h')], [c('10h'), c('Jh'), c('2h')])).toBe(2);
	});

	test('a made flush ignores straight cards that cannot make a straight flush', () => {
		// The 9 is a club, so no heart completes a straight flush.
		expect(countDrawingOuts([c('8h'), c('9c')], [c('10h'), c('Jh'), c('2h'), c('5h')])).toBe(0);
	});

	test('a pair inside a made straight has no trips outs', () => {
		expect(countDrawingOuts([c('9d'), c('9c')], [c('7s'), c('8h'), c('10d'), c('Jc')])).toBe(0);
	});
});
