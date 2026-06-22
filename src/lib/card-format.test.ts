/**
 * Unit tests for shared card-formatting helpers.
 */

import { describe, expect, test } from 'bun:test';
import { SUIT_SYMBOLS, getSuitSymbol, isRedSuit } from './card-format';

describe('card-format', () => {
	describe('getSuitSymbol', () => {
		test('maps each known suit to its glyph', () => {
			expect(getSuitSymbol('hearts')).toBe('♥');
			expect(getSuitSymbol('diamonds')).toBe('♦');
			expect(getSuitSymbol('clubs')).toBe('♣');
			expect(getSuitSymbol('spades')).toBe('♠');
		});

		test('falls back to the raw suit string for unknown suits', () => {
			// This is the contract every call site now depends on: an unknown
			// suit renders as itself rather than throwing or returning '?'.
			expect(getSuitSymbol('unknown')).toBe('unknown');
			expect(getSuitSymbol('')).toBe('');
		});

		test('SUIT_SYMBOLS exposes the four canonical glyphs', () => {
			expect(SUIT_SYMBOLS).toEqual({
				hearts: '♥',
				diamonds: '♦',
				clubs: '♣',
				spades: '♠',
			});
		});
	});

	describe('isRedSuit', () => {
		test('returns true for hearts and diamonds', () => {
			expect(isRedSuit('hearts')).toBe(true);
			expect(isRedSuit('diamonds')).toBe(true);
		});

		test('returns false for clubs, spades, and unknown suits', () => {
			expect(isRedSuit('clubs')).toBe(false);
			expect(isRedSuit('spades')).toBe(false);
			expect(isRedSuit('unknown')).toBe(false);
		});
	});
});
