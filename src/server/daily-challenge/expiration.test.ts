import { describe, expect, test } from 'bun:test';
import {
	DAILY_CHALLENGE_ATTEMPT_RETENTION_DAYS,
	DAILY_CHALLENGE_EXPIRATION_PAGE_SIZE,
	runDailyChallengeExpiration,
	runDailyChallengeRetention,
} from './expiration';
import type {
	DailyChallengeExpirationCursor,
	DailyChallengeExpirationRow,
	DailyChallengeRepository,
} from './repository';

interface ListCall {
	nowSeconds: number;
	cursor: DailyChallengeExpirationCursor | null;
}

function rowFor(id: string, index: number): DailyChallengeExpirationRow {
	return { id, expiresAt: 1_800_000_000 + index };
}

function createCursorAwareRepository(
	allRows: readonly DailyChallengeExpirationRow[],
	pageSize = DAILY_CHALLENGE_EXPIRATION_PAGE_SIZE,
) {
	const calls: ListCall[] = [];
	const repository = {
		listExpiredAttempts(
			nowSeconds: number,
			cursor?: DailyChallengeExpirationCursor | null,
		): Promise<readonly DailyChallengeExpirationRow[]> {
			calls.push({ nowSeconds, cursor: cursor ?? null });
			const filtered = cursor
				? allRows.filter(
						(r) =>
							r.expiresAt > cursor.expiresAt ||
							(r.expiresAt === cursor.expiresAt && r.id > cursor.id),
					)
				: [...allRows];
			return Promise.resolve(filtered.slice(0, pageSize));
		},
	};
	return { repository: repository as unknown as DailyChallengeRepository, calls };
}

function createRetentionRepository() {
	const calls: { cutoff: number }[] = [];
	const repository = {
		deleteTerminalAttemptsBefore(cutoff: number): Promise<number> {
			calls.push({ cutoff });
			return Promise.resolve(0);
		},
	};
	return { repository: repository as unknown as DailyChallengeRepository, calls };
}

describe('runDailyChallengeExpiration', () => {
	test('pages through an ordered page of 100 expired attempts and stops after the short final page', async () => {
		const totalIds = Array.from({ length: 150 }, (_, i) => `attempt-${String(i).padStart(3, '0')}`);
		const rows = totalIds.map((id, index) => rowFor(id, index));
		const { repository, calls } = createCursorAwareRepository(rows);
		const attempted: string[] = [];

		await runDailyChallengeExpiration(
			repository,
			async (attemptId) => {
				attempted.push(attemptId);
			},
			1_800_000_000,
		);

		expect(attempted).toEqual(totalIds);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.cursor).toBeNull();
		expect(calls[1]?.cursor).toEqual({
			expiresAt: rows[99]?.expiresAt,
			id: rows[99]?.id,
		});
	});

	test('returns without expiring when no active attempt has expired', async () => {
		const { repository, calls } = createCursorAwareRepository([]);
		const attempted: string[] = [];

		await runDailyChallengeExpiration(
			repository,
			async (attemptId) => {
				attempted.push(attemptId);
			},
			1_800_000_000,
		);

		expect(attempted).toEqual([]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cursor).toBeNull();
	});

	test('advances the (expiresAt, id) cursor between pages so progress is stable', async () => {
		const totalIds = Array.from({ length: 250 }, (_, i) => `attempt-${String(i).padStart(3, '0')}`);
		const rows = totalIds.map((id, index) => rowFor(id, index));
		const { repository, calls } = createCursorAwareRepository(rows);
		const attempted: string[] = [];

		await runDailyChallengeExpiration(
			repository,
			async (attemptId) => {
				attempted.push(attemptId);
			},
			1_800_000_000,
		);

		expect(attempted).toEqual(totalIds);
		expect(calls).toHaveLength(3);
		expect(calls[0]?.cursor).toBeNull();
		expect(calls[1]?.cursor).toEqual({
			expiresAt: rows[99]?.expiresAt,
			id: rows[99]?.id,
		});
		expect(calls[2]?.cursor).toEqual({
			expiresAt: rows[199]?.expiresAt,
			id: rows[199]?.id,
		});
	});

	test('a poison attempt mid-page does not block later attempts in the same page', async () => {
		const ids = ['poison-row', 'later-row-a', 'later-row-b'];
		const rows = ids.map((id, index) => rowFor(id, index));
		const { repository, calls } = createCursorAwareRepository(rows);
		const attempted: string[] = [];

		await runDailyChallengeExpiration(
			repository,
			async (attemptId) => {
				attempted.push(attemptId);
				if (attemptId === 'poison-row') throw new Error('corrupt attempt');
			},
			1_800_000_000,
		);

		expect(attempted).toEqual(ids);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cursor).toBeNull();
	});

	test('continues draining after a full page of failures to reach later pages', async () => {
		const poisonIds = Array.from({ length: 100 }, (_, i) => `poison-${String(i).padStart(3, '0')}`);
		const goodIds = Array.from({ length: 150 }, (_, i) => `good-${String(i).padStart(3, '0')}`);
		const allIds = [...poisonIds, ...goodIds];
		const rows = allIds.map((id, index) => rowFor(id, index));
		const { repository, calls } = createCursorAwareRepository(rows);
		const attempted: string[] = [];

		await runDailyChallengeExpiration(
			repository,
			async (attemptId) => {
				attempted.push(attemptId);
				if (attemptId.startsWith('poison-')) throw new Error('corrupt attempt');
			},
			1_800_000_000,
		);

		expect(attempted).toEqual(allIds);
		expect(attempted.filter((id) => id.startsWith('good-'))).toEqual(goodIds);
		expect(calls).toHaveLength(3);
		expect(calls[0]?.cursor).toBeNull();
		expect(calls[1]?.cursor).toEqual({
			expiresAt: rows[99]?.expiresAt,
			id: rows[99]?.id,
		});
		expect(calls[2]?.cursor).toEqual({
			expiresAt: rows[199]?.expiresAt,
			id: rows[199]?.id,
		});
	});

	test('uses the injected nowSeconds as the expiration cutoff', async () => {
		const rows = [rowFor('only-attempt', 0)];
		const { repository, calls } = createCursorAwareRepository(rows);

		await runDailyChallengeExpiration(repository, async () => undefined, 1_900_000_000);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.nowSeconds).toBe(1_900_000_000);
	});
});

describe('runDailyChallengeRetention', () => {
	test('delegates with a 90-day cutoff derived from the injected nowSeconds', async () => {
		const { repository, calls } = createRetentionRepository();
		const nowSeconds = 1_800_000_000;

		await runDailyChallengeRetention(repository, nowSeconds);

		expect(calls).toEqual([
			{ cutoff: nowSeconds - DAILY_CHALLENGE_ATTEMPT_RETENTION_DAYS * 24 * 60 * 60 },
		]);
	});

	test('DAILY_CHALLENGE_ATTEMPT_RETENTION_DAYS is exactly 90', () => {
		expect(DAILY_CHALLENGE_ATTEMPT_RETENTION_DAYS).toBe(90);
	});

	test('DAILY_CHALLENGE_EXPIRATION_PAGE_SIZE is exactly 100', () => {
		expect(DAILY_CHALLENGE_EXPIRATION_PAGE_SIZE).toBe(100);
	});

	test('does not read Date.now when computing the cutoff', async () => {
		const { repository, calls } = createRetentionRepository();
		const fixedNow = 1_234_567_890;
		const realDateNow = Date.now;
		Date.now = () => {
			throw new Error('retention must not read Date.now');
		};
		try {
			await runDailyChallengeRetention(repository, fixedNow);
		} finally {
			Date.now = realDateNow;
		}
		expect(calls).toEqual([{ cutoff: fixedNow - 90 * 24 * 60 * 60 }]);
	});
});
