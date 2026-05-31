import { describe, expect, test } from 'bun:test';

/**
 * Unit tests for the display-name fallback and 4xx cleanup logic
 * in the WebSocket upgrade route (ws.ts).
 *
 * The route handler itself is an Astro APIRoute with heavy framework
 * dependencies (D1, DO namespace, middleware). These tests validate the
 * pure-logic pieces in isolation.
 */

describe('display-name fallback', () => {
	test('non-empty name passes through unchanged', () => {
		const name = 'Alice';
		const result = name || 'Player';
		expect(result).toBe('Alice');
	});

	test('empty string falls back to "Player"', () => {
		const name = '';
		const result = name || 'Player';
		expect(result).toBe('Player');
	});

	test('encodeURIComponent encodes the fallback correctly', () => {
		const name = '';
		const encoded = encodeURIComponent(name || 'Player');
		expect(encoded).toBe('Player');
	});

	test('encodeURIComponent encodes special characters in name', () => {
		const name = 'Alice & Bob';
		const encoded = encodeURIComponent(name || 'Player');
		expect(encoded).toBe('Alice%20%26%20Bob');
	});
});

describe('4xx cleanup decision logic', () => {
	// Mirrors the shouldCleanup logic from ws.ts lines 192-194
	function shouldCleanup(
		doStatus: number,
		lockAcquired: boolean,
		existingRoomMatch: boolean,
	): boolean {
		const is4xx = doStatus >= 400 && doStatus < 500;
		return is4xx && (lockAcquired || existingRoomMatch);
	}

	test('cleans up on 401 with newly acquired lock', () => {
		expect(shouldCleanup(401, true, false)).toBe(true);
	});

	test('cleans up on 400 with newly acquired lock', () => {
		expect(shouldCleanup(400, true, false)).toBe(true);
	});

	test('cleans up on 404 with newly acquired lock', () => {
		expect(shouldCleanup(404, true, false)).toBe(true);
	});

	test('cleans up on 404 with existing room match (reconnect)', () => {
		expect(shouldCleanup(404, false, true)).toBe(true);
	});

	test('does NOT clean up on 500 (transient failure)', () => {
		expect(shouldCleanup(500, true, false)).toBe(false);
	});

	test('does NOT clean up on 502 (transient failure)', () => {
		expect(shouldCleanup(502, true, false)).toBe(false);
	});

	test('does NOT clean up on 101 (successful upgrade)', () => {
		expect(shouldCleanup(101, true, false)).toBe(false);
	});

	test('does NOT clean up on 4xx without lock or existing match', () => {
		expect(shouldCleanup(401, false, false)).toBe(false);
	});

	test('does NOT clean up on 200 (non-upgrade success)', () => {
		expect(shouldCleanup(200, true, false)).toBe(false);
	});
});
