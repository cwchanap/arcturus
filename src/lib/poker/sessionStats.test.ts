import { afterEach, describe, expect, test } from 'bun:test';
import {
	EMPTY_SESSION_STATS,
	SESSION_STATS_KEY,
	loadSessionStats,
	recordHand,
	saveSessionStats,
} from './sessionStats';

const globalWithStorage = globalThis as typeof globalThis & { sessionStorage?: Storage };
const originalStorage = globalWithStorage.sessionStorage;

afterEach(() => {
	globalWithStorage.sessionStorage = originalStorage;
});

describe('recordHand', () => {
	test('tracks net, streak, biggest pot, and best hand', () => {
		let stats = recordHand(EMPTY_SESSION_STATS, { delta: 60, potWon: 90, handKey: 'PAIR' });
		stats = recordHand(stats, { delta: 120, potWon: 150, handKey: 'FLUSH' });
		expect(stats).toEqual({
			hands: 2,
			net: 180,
			streak: 2,
			biggestPot: 150,
			bestHand: 'FLUSH',
		});

		stats = recordHand(stats, { delta: -40, potWon: 0, handKey: 'TWO_PAIR' });
		expect(stats).toMatchObject({ hands: 3, net: 140, streak: 0, bestHand: 'FLUSH' });
	});

	test('a push breaks the streak without changing net', () => {
		const stats = recordHand(
			{ ...EMPTY_SESSION_STATS, hands: 1, net: 10, streak: 1 },
			{ delta: 0, potWon: 20, handKey: null },
		);
		expect(stats).toMatchObject({ net: 10, streak: 0, biggestPot: 20 });
	});
});

describe('session persistence', () => {
	test('round-trips through sessionStorage and ignores bad data', () => {
		const store: Record<string, string> = {};
		globalWithStorage.sessionStorage = {
			getItem: (key: string) => store[key] ?? null,
			setItem: (key: string, value: string) => {
				store[key] = value;
			},
		} as Storage;

		saveSessionStats({ hands: 4, net: -20, streak: 0, biggestPot: 80, bestHand: 'STRAIGHT' });
		expect(loadSessionStats()).toEqual({
			hands: 4,
			net: -20,
			streak: 0,
			biggestPot: 80,
			bestHand: 'STRAIGHT',
		});

		store[SESSION_STATS_KEY] = '{"hands":"x","bestHand":"NOPE"}';
		expect(loadSessionStats()).toEqual(EMPTY_SESSION_STATS);
	});

	test('falls back to an empty tally when storage is unavailable', () => {
		globalWithStorage.sessionStorage = undefined;
		expect(loadSessionStats()).toEqual(EMPTY_SESSION_STATS);
		expect(() => saveSessionStats(EMPTY_SESSION_STATS)).not.toThrow();
	});
});
