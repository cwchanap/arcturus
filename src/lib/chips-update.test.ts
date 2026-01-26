import { describe, expect, it } from 'bun:test';
import { getRowsAffected } from '../pages/api/chips/update';

describe('getRowsAffected', () => {
	it('prefers meta changes when present', () => {
		const result = { meta: { changes: 2 }, rowsAffected: 5 };
		expect(getRowsAffected(result)).toBe(2);
	});

	it('falls back to rowsAffected when meta is missing', () => {
		const result = { rowsAffected: 3 };
		expect(getRowsAffected(result)).toBe(3);
	});

	it('returns 0 for nullish results', () => {
		expect(getRowsAffected(null)).toBe(0);
		expect(getRowsAffected(undefined)).toBe(0);
	});
});
