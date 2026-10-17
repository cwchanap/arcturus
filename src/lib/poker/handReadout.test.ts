import { describe, expect, test } from 'bun:test';
import { readHand } from './handReadout';
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

	test('finds a straight using one hole card', () => {
		const readout = readHand([c('2d'), c('9h')], [c('4h'), c('Qs'), c('10d'), c('8c'), c('Js')]);
		expect(readout?.key).toBe('STRAIGHT');
		expect(codes(readout!.coreCards)).toEqual(['10d', '8c', '9h', 'Js', 'Qs']);
	});

	test('flags a hand that the board plays entirely', () => {
		const readout = readHand([c('2d'), c('3c')], [c('Kh'), c('Ks'), c('9d'), c('8c'), c('5s')]);
		expect(readout?.key).toBe('PAIR');
		expect(readout?.usesHoleCards).toBe(false);
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
