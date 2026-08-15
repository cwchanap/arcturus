/**
 * Unit tests for dice helpers
 */

import { describe, expect, test } from 'bun:test';
import { rollDie, rollThreeDice } from './dice';

describe('rollDie', () => {
	test('maps random() 0 to face 1', () => {
		expect(rollDie(() => 0)).toBe(1);
	});

	test('maps random() just below 1 to face 6', () => {
		expect(rollDie(() => 0.999999)).toBe(6);
	});
});

describe('rollThreeDice', () => {
	test('uses the injected random source for all three dice', () => {
		const sequence = [0, 0.5, 0.9];
		let index = 0;
		expect(rollThreeDice(() => sequence[index++]!)).toEqual([1, 4, 6]);
	});
});
