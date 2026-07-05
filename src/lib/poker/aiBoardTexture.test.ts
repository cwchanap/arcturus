import { describe, expect, test } from 'bun:test';
import type { Card } from './types';
import { classifyBoardTexture } from './aiBoardTexture';

function card(value: string, suit: Card['suit'], rank: number): Card {
	return { value, suit, rank };
}

describe('classifyBoardTexture', () => {
	test('classifies preflop as none with no pressure', () => {
		const texture = classifyBoardTexture([]);

		expect(texture.kind).toBe('none');
		expect(texture.pressure).toBe(0);
		expect(texture.tags).toContain('preflop');
	});

	test('classifies disconnected rainbow flop as dry', () => {
		const texture = classifyBoardTexture([
			card('K', 'spades', 13),
			card('7', 'diamonds', 7),
			card('2', 'clubs', 2),
		]);

		expect(texture.kind).toBe('dry');
		expect(texture.flushDrawPossible).toBe(false);
		expect(texture.straightDrawPossible).toBe(false);
		expect(texture.pressure).toBeLessThan(0.35);
	});

	test('detects two-tone connected board as wet', () => {
		const texture = classifyBoardTexture([
			card('J', 'hearts', 11),
			card('10', 'hearts', 10),
			card('9', 'clubs', 9),
		]);

		expect(texture.kind).toBe('wet');
		expect(texture.flushDrawPossible).toBe(true);
		expect(texture.straightDrawPossible).toBe(true);
		expect(texture.tags).toContain('two-tone');
		expect(texture.pressure).toBeGreaterThan(0.55);
	});

	test('detects paired boards', () => {
		const texture = classifyBoardTexture([
			card('Q', 'spades', 12),
			card('Q', 'diamonds', 12),
			card('4', 'clubs', 4),
		]);

		expect(texture.paired).toBe(true);
		expect(texture.tags).toContain('paired');
	});

	test('detects monotone boards as high flush pressure', () => {
		const texture = classifyBoardTexture([
			card('A', 'spades', 14),
			card('8', 'spades', 8),
			card('3', 'spades', 3),
		]);

		expect(texture.monotone).toBe(true);
		expect(texture.flushDrawPossible).toBe(true);
		expect(texture.tags).toContain('monotone');
		expect(texture.pressure).toBeGreaterThan(0.5);
		// Ace-high monotone carries a nut-flush threat and must classify as wet,
		// not semi-wet.
		expect(texture.kind).toBe('wet');
	});

	test('does not label turn/river flush draws as monotone', () => {
		// 4-card board with 3 spades is a flush draw, not a monotone board.
		// The `monotone` label is flop-only; pressure must stay high anyway.
		const texture = classifyBoardTexture([
			card('A', 'spades', 14),
			card('8', 'spades', 8),
			card('3', 'spades', 3),
			card('2', 'clubs', 2),
		]);

		expect(texture.monotone).toBe(false);
		expect(texture.tags).not.toContain('monotone');
		expect(texture.tags).toContain('flush-draw');
		// Flush-draw pressure is preserved even though the monotone label is off.
		expect(texture.pressure).toBeGreaterThan(0.5);
		expect(texture.kind).toBe('wet');
	});
});
