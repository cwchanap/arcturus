import { describe, expect, test } from 'bun:test';
import { generateRoomCode, isValidRoomCode } from './roomCode';

describe('roomCode', () => {
	test('generateRoomCode produces MP- prefix + 6 alphanumeric chars', () => {
		const code = generateRoomCode();
		expect(code).toMatch(/^MP-[A-Z0-9]{6}$/);
	});

	test('generateRoomCode produces different codes on consecutive calls', () => {
		const codes = new Set<string>();
		for (let i = 0; i < 100; i++) codes.add(generateRoomCode());
		expect(codes.size).toBe(100);
	});

	test('isValidRoomCode accepts well-formed codes', () => {
		expect(isValidRoomCode('MP-7HXK4Q')).toBe(true);
		expect(isValidRoomCode('MP-ABCDEF')).toBe(true);
	});

	test('isValidRoomCode rejects malformed codes', () => {
		expect(isValidRoomCode('mp-7hxk4q')).toBe(false);
		expect(isValidRoomCode('MP-7HXK4')).toBe(false);
		expect(isValidRoomCode('MP-7HXK4QZ')).toBe(false);
		expect(isValidRoomCode('XX-7HXK4Q')).toBe(false);
		expect(isValidRoomCode('MP_7HXK4Q')).toBe(false);
		expect(isValidRoomCode('')).toBe(false);
	});
});
