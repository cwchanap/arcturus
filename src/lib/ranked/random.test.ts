import { describe, expect, test } from 'bun:test';
import type { Card } from '../blackjack/types';
import {
	createRankedRandomSource,
	createRankedSeed,
	createSeedCommitment,
	deriveRankedCounterBlock,
	encodeUint64BigEndian,
	shuffleRankedDeck,
} from './random';

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const seed = Uint8Array.from({ length: 32 }, (_, index) => index);

describe('ranked seed and HMAC stream', () => {
	test('pins the v1 HMAC block and seed commitment', () => {
		expect(bytesToHex(deriveRankedCounterBlock(seed, 0n))).toBe(
			'26703278906b275d44e68bcccc9563a062c2364c71cd76679fe6d1a3afc86ac3',
		);
		expect(createSeedCommitment(seed)).toBe(
			'53b7d7e3c3cccc4d50c84318061deca625f712619eab99f8dd1c0b66c7d9ef7e',
		);
	});

	test('uses unsigned 32-bit rejection sampling without modulo bias', () => {
		const random = createRankedRandomSource(seed);
		const upperBound = 0x8000_0001;

		expect(random.nextInt(upperBound)).toBe(644887160);
		// The next stream word (2422941533) is above the acceptance limit,
		// so this fixture pins that it is rejected in favor of 1155959756.
		expect(random.nextInt(upperBound)).toBe(1155959756);
	});

	test.each([0, -1, 1.5, 0x1_0000_0001, Number.NaN])(
		'rejects invalid exclusive upper bound %p',
		(upperBound) => {
			const random = createRankedRandomSource(seed);
			expect(() => random.nextInt(upperBound)).toThrow();
		},
	);

	test.each([new Uint8Array(), new Uint8Array(31), new Uint8Array(33)])(
		'rejects a seed that is not exactly 32 bytes',
		(invalidSeed) => {
			expect(() => createRankedRandomSource(invalidSeed)).toThrow();
			expect(() => deriveRankedCounterBlock(invalidSeed, 0n)).toThrow();
			expect(() => createSeedCommitment(invalidSeed)).toThrow();
		},
	);

	test('rejects negative and overflowing counters', () => {
		expect(() => deriveRankedCounterBlock(seed, -1n)).toThrow();
		expect(() => deriveRankedCounterBlock(seed, 0x1_0000_0000_0000_0000n)).toThrow();
		expect(deriveRankedCounterBlock(seed, 0xffff_ffff_ffff_ffffn)).toHaveLength(32);
	});

	test('encodeUint64BigEndian pins the unsigned 64-bit big-endian byte order', () => {
		expect(bytesToHex(encodeUint64BigEndian(0n))).toBe('0000000000000000');
		expect(bytesToHex(encodeUint64BigEndian(1n))).toBe('0000000000000001');
		expect(bytesToHex(encodeUint64BigEndian(0x0102030405060708n))).toBe('0102030405060708');
		expect(encodeUint64BigEndian(0n)).toHaveLength(8);
	});

	test('encodeUint64BigEndian rejects negative and overflowing values', () => {
		expect(() => encodeUint64BigEndian(-1n)).toThrow();
		expect(() => encodeUint64BigEndian(0x1_0000_0000_0000_0000n)).toThrow();
		expect(() => encodeUint64BigEndian(0xffff_ffff_ffff_ffffn + 1n)).toThrow();
	});

	test('creates exactly 32 bytes of secure seed material', () => {
		expect(createRankedSeed()).toHaveLength(32);
	});
});

describe('ranked deck shuffle', () => {
	test('pins the v1 suit/rank order, Fisher-Yates stream, and deal-from-end direction', () => {
		const deck = shuffleRankedDeck(seed);
		const firstTenDealt = deck.slice(-10).reverse();
		const expected: Card[] = [
			{ rank: '9', suit: 'hearts' },
			{ rank: 'A', suit: 'clubs' },
			{ rank: '7', suit: 'hearts' },
			{ rank: 'J', suit: 'clubs' },
			{ rank: '6', suit: 'spades' },
			{ rank: 'Q', suit: 'hearts' },
			{ rank: 'J', suit: 'diamonds' },
			{ rank: '4', suit: 'diamonds' },
			{ rank: '4', suit: 'hearts' },
			{ rank: 'K', suit: 'diamonds' },
		];

		expect(deck).toHaveLength(52);
		expect(new Set(deck.map((card) => `${card.rank}-${card.suit}`))).toHaveLength(52);
		expect(firstTenDealt).toEqual(expected);
	});
});
