/**
 * Unit tests for shared card-formatting helpers.
 */

import { describe, expect, test } from 'bun:test';
import { SUIT_SYMBOLS, getSuitGlyph, getSuitSymbol, isRedSuit } from './card-format';

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

	describe('getSuitGlyph', () => {
		test('maps each known suit to its glyph', () => {
			expect(getSuitGlyph('hearts')).toBe('♥');
			expect(getSuitGlyph('diamonds')).toBe('♦');
			expect(getSuitGlyph('clubs')).toBe('♣');
			expect(getSuitGlyph('spades')).toBe('♠');
		});

		test("returns '?' for unknown suits", () => {
			// This is the contract the mp-poker page's createCardEl previously
			// derived inline (`sym === c.suit ? '?' : sym`). Pinning it here
			// ensures a future "simplification" to getSuitSymbol cannot
			// silently regress the '?' placeholder rendering.
			expect(getSuitGlyph('unknown')).toBe('?');
			expect(getSuitGlyph('')).toBe('?');
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
