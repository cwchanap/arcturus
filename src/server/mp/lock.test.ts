import { describe, expect, test } from 'bun:test';
import { lockBodySchema } from '../../pages/api/mp/lock';

describe('lockBodySchema', () => {
	test('accepts valid acquire with roomCode', () => {
		const result = lockBodySchema.safeParse({ action: 'acquire', roomCode: 'ABCD' });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.action).toBe('acquire');
			expect(result.data.roomCode).toBe('ABCD');
		}
	});

	test('rejects acquire without roomCode', () => {
		const result = lockBodySchema.safeParse({ action: 'acquire' });
		expect(result.success).toBe(false);
	});

	test('rejects acquire with empty roomCode', () => {
		const result = lockBodySchema.safeParse({ action: 'acquire', roomCode: '' });
		expect(result.success).toBe(false);
	});

	test('accepts valid release', () => {
		const result = lockBodySchema.safeParse({ action: 'release' });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.action).toBe('release');
			expect(result.data.roomCode).toBeUndefined();
		}
	});

	test('rejects invalid action', () => {
		const result = lockBodySchema.safeParse({ action: 'destroy' });
		expect(result.success).toBe(false);
	});

	test('rejects missing action', () => {
		const result = lockBodySchema.safeParse({ roomCode: 'ABCD' });
		expect(result.success).toBe(false);
	});

	test('rejects non-string action', () => {
		const result = lockBodySchema.safeParse({ action: 42 });
		expect(result.success).toBe(false);
	});

	test('rejects non-string roomCode', () => {
		const result = lockBodySchema.safeParse({ action: 'acquire', roomCode: 123 });
		expect(result.success).toBe(false);
	});

	test('rejects empty object', () => {
		const result = lockBodySchema.safeParse({});
		expect(result.success).toBe(false);
	});

	test('rejects null', () => {
		const result = lockBodySchema.safeParse(null);
		expect(result.success).toBe(false);
	});
});
