import { describe, expect, test } from 'bun:test';
import { extractBalancedJsonObjects } from './llm-response-parsing';

describe('extractBalancedJsonObjects', () => {
	test('returns empty array for input with no braces', () => {
		expect(extractBalancedJsonObjects('no json here')).toEqual([]);
	});

	test('extracts a single balanced object', () => {
		expect(extractBalancedJsonObjects('prefix {"a":1} suffix')).toEqual(['{"a":1}']);
	});

	test('extracts multiple balanced objects', () => {
		expect(extractBalancedJsonObjects('{"a":1} text {"b":2}')).toEqual(['{"a":1}', '{"b":2}']);
	});

	test('handles nested braces', () => {
		expect(extractBalancedJsonObjects('{"a":{"b":2}}')).toEqual(['{"a":{"b":2}}']);
	});

	test('ignores braces inside string literals', () => {
		expect(extractBalancedJsonObjects('{"a":"}{"}')).toEqual(['{"a":"}{"}']);
	});

	test('handles escaped quotes inside string literals', () => {
		// The escaped quote should not toggle inString, and a brace after it is ignored.
		expect(extractBalancedJsonObjects('{"a":"he said \\"}"}')).toEqual(['{"a":"he said \\"}"}']);
	});

	test('ignores backslash outside of strings', () => {
		// A backslash outside a string is a literal character, not an escape.
		expect(extractBalancedJsonObjects('\\{"a":1}')).toEqual(['{"a":1}']);
	});

	test('resets start on unmatched closing brace', () => {
		// A stray '}' with no matching '{' should reset start so the next object is captured fully.
		expect(extractBalancedJsonObjects('} {"a":1}')).toEqual(['{"a":1}']);
	});

	test('does not capture an unclosed object', () => {
		expect(extractBalancedJsonObjects('{"a":1')).toEqual([]);
	});
});
